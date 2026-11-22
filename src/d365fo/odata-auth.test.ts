import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AppConfig } from '../config/index.js';
import { BrowserTokenSource, createODataTokenSource, describeTokenError, discoverTenant, fnoOrigin, ODataSignInError, odataAuthMode, PasswordTokenSource, signInFile, tokenAccount } from './odata-auth.js';

const ORIGIN = 'https://x.sandbox.operations.dynamics.com';
const jwt = (claims: object): string => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A Microsoft token endpoint that records the form it was sent. */
function tokenEndpoint(reply: (form: URLSearchParams) => Response) {
  const forms: URLSearchParams[] = [];
  const urls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    const form = new URLSearchParams(String(init?.body ?? ''));
    forms.push(form);
    return reply(form);
  }) as typeof fetch;
  return { f, forms, urls };
}

describe('which data-access sign-in is used', () => {
  const base = { D365_ODATA_AUTH: undefined, D365_STORAGE_STATE: undefined, D365_USERNAME: undefined, D365_PASSWORD: undefined };
  it('follows the setting, else how the tests sign in, else the Azure CLI', () => {
    assert.equal(odataAuthMode({ ...base, D365_ODATA_AUTH: 'azure-cli', D365_STORAGE_STATE: 's.json' }), 'azure-cli');
    assert.equal(odataAuthMode({ ...base, D365_STORAGE_STATE: 's.json', D365_USERNAME: 'u', D365_PASSWORD: 'p' }), 'browser');
    assert.equal(odataAuthMode({ ...base, D365_USERNAME: 'u', D365_PASSWORD: 'p' }), 'password');
    assert.equal(odataAuthMode(base), 'azure-cli');
  });

  it('uses the F&O origin only, over https', () => {
    assert.equal(fnoOrigin('https://x.sandbox.operations.dynamics.com/?cmp=USMF'), ORIGIN);
    assert.throws(() => fnoOrigin('http://x.example.com'), /must be https/);
    assert.throws(() => fnoOrigin(undefined), /No F&O address/);
  });

  it('builds the source for the mode, and needs credentials for a password', () => {
    const cfg = { D365_BASE_URL: ORIGIN, PROFILE_ID: 'abc12345' } as AppConfig;
    assert.equal(createODataTokenSource({ ...cfg, D365_ODATA_AUTH: 'browser' }).mode, 'browser');
    assert.equal(createODataTokenSource({ ...cfg, D365_USERNAME: 'u', D365_PASSWORD: 'p' }).mode, 'password');
    assert.equal(createODataTokenSource(cfg).mode, 'azure-cli');
    assert.throws(() => createODataTokenSource({ ...cfg, D365_ODATA_AUTH: 'password' }), /needs D365_USERNAME and D365_PASSWORD/);
    assert.equal(signInFile({ PROFILE_ID: 'abc12345' }, '/home'), join('/home', 'odata', 'abc12345.json'));
  });
});

describe('tenant discovery and errors', () => {
  it('reads the tenant from the 401 challenge', async () => {
    const f = (async () => new Response('', { status: 401, headers: { 'www-authenticate': 'authorization_uri="https://login.windows.net/Contoso.onmicrosoft.com/oauth2/authorize", Bearer' } })) as typeof fetch;
    assert.equal(await discoverTenant(ORIGIN, f), 'Contoso.onmicrosoft.com');
    assert.equal(await discoverTenant(ORIGIN, (async () => new Response('', { status: 401 })) as typeof fetch), undefined);
    assert.equal(await discoverTenant(ORIGIN, (async () => { throw new Error('offline'); }) as typeof fetch), undefined);
  });

  it('explains MFA, a refused password, an expired sign-in and a missing consent', () => {
    assert.match(describeTokenError({ error: 'interaction_required', error_description: 'AADSTS50076: MFA' }), /multi-factor[\s\S]*browser/);
    assert.match(describeTokenError({ error_description: 'AADSTS50126: Error validating credentials' }), /refused the username or password/);
    assert.match(describeTokenError({ error: 'invalid_grant', error_description: 'AADSTS700082: expired' }, true), /expired[\s\S]*Sign in again/);
    assert.match(describeTokenError({ error_description: 'AADSTS65001: no consent' }), /administrator/);
    assert.match(describeTokenError({ error: 'weird', error_description: 'Something odd\nmore' }), /^Microsoft refused the sign-in for data access: Something odd$/);
  });

  it('reads who a token is for', () => {
    assert.equal(tokenAccount(jwt({ upn: 'jo@contoso.com' })), 'jo@contoso.com');
    assert.equal(tokenAccount(jwt({ preferred_username: 'p@contoso.com' })), 'p@contoso.com');
    assert.equal(tokenAccount('garbage'), undefined);
  });
});

describe('password sign-in', () => {
  it('asks Microsoft for a token for F&O with the configured account and keeps it until shortly before it expires', async () => {
    const ep = tokenEndpoint(() => json({ access_token: 'T1', expires_in: 3600 }));
    let now = 0;
    const source = new PasswordTokenSource(ORIGIN, 'jo@contoso.com', 'pw', 'contoso.com', ep.f, () => now);
    assert.equal(await source.token(), 'T1');
    assert.equal(await source.token(), 'T1');
    assert.equal(ep.forms.length, 1);
    assert.equal(ep.urls[0], 'https://login.microsoftonline.com/contoso.com/oauth2/v2.0/token');
    assert.equal(ep.forms[0].get('grant_type'), 'password');
    assert.equal(ep.forms[0].get('scope'), `${ORIGIN}/.default`);
    assert.equal(ep.forms[0].get('username'), 'jo@contoso.com');
    now = 3500 * 1000;
    await source.token();
    assert.equal(ep.forms.length, 2, 'renewed once it was about to expire');
  });

  it('tells an MFA account to use the browser sign-in', async () => {
    const ep = tokenEndpoint(() => json({ error: 'interaction_required', error_description: 'AADSTS50076: MFA needed' }, 400));
    await assert.rejects(new PasswordTokenSource(ORIGIN, 'u', 'p', 'organizations', ep.f).token(), /multi-factor[\s\S]*browser/);
  });
});

describe('browser sign-in', () => {
  const setup = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'odata-auth-'));
    return { file: join(dir, 'odata', 'p.json') };
  };

  /** Plays the part of the browser: follows the authorize URL's redirect back to the loopback with a code. */
  const browser = (override: { state?: (s: string) => string; error?: string } = {}) => {
    const seen: { url?: URL } = {};
    const open = async (u: string): Promise<void> => {
      const url = new URL(u);
      seen.url = url;
      const back = new URL(url.searchParams.get('redirect_uri')!);
      if (override.error) back.searchParams.set('error', override.error);
      else back.searchParams.set('code', 'the-code');
      back.searchParams.set('state', override.state ? override.state(url.searchParams.get('state')!) : url.searchParams.get('state')!);
      void fetch(back.toString().replace('localhost', '127.0.0.1')).catch(() => undefined);
    };
    return { open, seen };
  };

  it('signs in with PKCE through the loopback, keeps the refresh token, and reuses it without another sign-in', async () => {
    const { file } = await setup();
    const ep = tokenEndpoint((form) => form.get('grant_type') === 'authorization_code'
      ? json({ access_token: jwt({ upn: 'jo@contoso.com' }), refresh_token: 'R1', expires_in: 3600 })
      : json({ access_token: 'T2', refresh_token: 'R2', expires_in: 3600 }));
    const b = browser();
    const source = new BrowserTokenSource(ORIGIN, file, ep.f);
    assert.deepEqual(await source.login({ open: b.open, tenant: 'contoso.com' }), { account: 'jo@contoso.com' });

    const auth = b.seen.url!;
    assert.equal(auth.origin + auth.pathname, 'https://login.microsoftonline.com/contoso.com/oauth2/v2.0/authorize');
    assert.equal(auth.searchParams.get('scope'), `${ORIGIN}/.default offline_access`);
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.match(auth.searchParams.get('redirect_uri')!, /^http:\/\/localhost:\d+$/);
    const exchange = ep.forms[0];
    assert.equal(exchange.get('code'), 'the-code');
    assert.ok(exchange.get('code_verifier'), 'the PKCE verifier is sent with the code');

    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(stored, { origin: ORIGIN, tenant: 'contoso.com', refreshToken: 'R1', account: 'jo@contoso.com' });
    assert.deepEqual(await source.status(), { signedIn: true, account: 'jo@contoso.com' });

    // A later run (a new source) renews from the file, and keeps the rotated refresh token.
    const later = new BrowserTokenSource(ORIGIN, file, ep.f);
    assert.equal(await later.token(), 'T2');
    assert.equal(ep.forms.at(-1)?.get('grant_type'), 'refresh_token');
    assert.equal(ep.forms.at(-1)?.get('refresh_token'), 'R1');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).refreshToken, 'R2');
  });

  it('does not use a sign-in made for another F&O address, and says how to sign in', async () => {
    const { file } = await setup();
    const ep = tokenEndpoint(() => json({ access_token: 'x', refresh_token: 'r' }));
    await new BrowserTokenSource('https://other.operations.dynamics.com', file, ep.f).login({ open: browser().open, tenant: 'organizations' });
    const source = new BrowserTokenSource(ORIGIN, file, ep.f);
    assert.deepEqual(await source.status(), { signedIn: false });
    await assert.rejects(source.token(), /Not signed in for data access[\s\S]*d365-data-login/);
  });

  it('rejects a redirect with the wrong state and saves nothing', async () => {
    const { file } = await setup();
    const ep = tokenEndpoint(() => json({ access_token: 'x', refresh_token: 'r' }));
    const source = new BrowserTokenSource(ORIGIN, file, ep.f);
    await assert.rejects(source.login({ open: browser({ state: () => 'forged' }).open, tenant: 'organizations' }), /did not finish/);
    assert.equal(ep.forms.length, 0, 'no code was exchanged');
    assert.deepEqual(await source.status(), { signedIn: false });
  });

  it('reports a sign-in the user cancelled or that never finished', async () => {
    const { file } = await setup();
    const source = new BrowserTokenSource(ORIGIN, file, tokenEndpoint(() => json({})).f);
    await assert.rejects(source.login({ open: browser({ error: 'access_denied' }).open, tenant: 'organizations' }), /did not finish: access_denied/);
    await assert.rejects(source.login({ open: async () => undefined, timeoutMs: 50, tenant: 'organizations' }), /did not finish: no sign-in was completed/);
  });

  it('asks to sign in again when the refresh token no longer works, and forgets a sign-in on logout', async () => {
    const { file } = await setup();
    await new BrowserTokenSource(ORIGIN, file, tokenEndpoint(() => json({ access_token: 'a', refresh_token: 'r' })).f).login({ open: browser().open, tenant: 'organizations' });
    const expired = tokenEndpoint(() => json({ error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired' }, 400));
    const source = new BrowserTokenSource(ORIGIN, file, expired.f);
    await assert.rejects(source.token(), (e: unknown) => e instanceof ODataSignInError && /expired[\s\S]*Sign in again/.test(e.message));
    await source.logout();
    assert.deepEqual(await source.status(), { signedIn: false });
    await writeFile(file, 'not json');
    assert.deepEqual(await source.status(), { signedIn: false });
  });
});
