import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateForRun, type AppConfig } from '../config/index.js';
import { buildODataPath, D365ODataClient } from './entra.js';

const cfg = (extra: Partial<AppConfig> = {}) =>
  ({
    LLM_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'k',
    D365_BASE_URL: 'https://x.sandbox.operations.dynamics.com/',
    D365_TENANT_ID: 'tenant',
    D365_CLIENT_ID: 'client',
    D365_CLIENT_SECRET: 'secret',
    AZDO_HTTP_TIMEOUT_MS: 1000,
    AZDO_HTTP_MAX_RETRIES: 0,
    AZDO_HTTP_RETRY_BASE_MS: 1,
    ...extra,
  }) as AppConfig;

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as never;
  return { impl, calls };
}

describe('buildODataPath', () => {
  it('builds a bounded read-only query', () => {
    const p = buildODataPath({ entity: 'VendorsV2', filter: "VendorAccountNumber eq 'V 1'", select: 'A, B', top: 500, crossCompany: true });
    assert.equal(p, "/data/VendorsV2?%24filter=VendorAccountNumber%20eq%20%27V%201%27&%24select=A%2CB&%24top=50&cross-company=true");
  });
  it('rejects entity names that could change the path', () => {
    assert.throws(() => buildODataPath({ entity: '../Vendors' }));
    assert.throws(() => buildODataPath({ entity: 'Vendors?$x' }));
    assert.throws(() => buildODataPath({ entity: 'VendorsV2', select: 'A;drop' }));
  });
});

describe('D365ODataClient', () => {
  it('gets a client-credentials token for the F&O resource and caches it', async () => {
    const f = fakeFetch((url) =>
      url.includes('/oauth2/') ? { status: 200, body: { access_token: 'tok', expires_in: 3600 } } : { status: 200, body: { value: [{ '@odata.etag': 'x', Id: 'V1' }] } },
    );
    const client = new D365ODataClient(cfg(), f.impl);
    assert.equal(await client.query({ entity: 'VendorsV2' }), JSON.stringify({ count: 1, rows: [{ Id: 'V1' }] }));
    await client.query({ entity: 'VendorsV2' });
    const tokenCalls = f.calls.filter((c) => c.url.includes('/oauth2/'));
    assert.equal(tokenCalls.length, 1);
    assert.equal(tokenCalls[0].url, 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token');
    const form = new URLSearchParams(String(tokenCalls[0].init.body));
    assert.equal(form.get('scope'), 'https://x.sandbox.operations.dynamics.com/.default');
    assert.equal(form.get('grant_type'), 'client_credentials');
    assert.equal((f.calls[1].init.headers as Record<string, string>).authorization, 'Bearer tok');
  });

  it('reports a refused app with the registration hint', async () => {
    const f = fakeFetch((url) => (url.includes('/oauth2/') ? { status: 200, body: { access_token: 'tok' } } : { status: 401, body: '' }));
    const r = await new D365ODataClient(cfg(), f.impl).check();
    assert.equal(r.ok, false);
    assert.match(r.detail, /Microsoft Entra ID applications/);
  });

  it('reports a failed Entra sign-in', async () => {
    const f = fakeFetch(() => ({ status: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret.\r\nTrace ID: 1' } }));
    const r = await new D365ODataClient(cfg(), f.impl).check();
    assert.deepEqual(r, { ok: false, detail: 'Entra sign-in for the app registration failed: AADSTS7000215: Invalid client secret.' });
  });
});

describe('validateForRun with an app registration', () => {
  it('accepts an app registration without user credentials', () => {
    assert.deepEqual(validateForRun(cfg()), []);
  });
  it('flags a partial app registration', () => {
    const issues = validateForRun(cfg({ D365_CLIENT_SECRET: undefined }));
    assert.ok(issues.some((i) => /needs all three/.test(i)));
  });
});
