import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { validateForRun, type AppConfig } from '../config/index.js';
import { buildDefaultManager } from '../mcp/registry.js';
import { d365SystemGuidance } from './guidance.js';
import { activeSessionFile, checkSession, interactiveSessionLogin, probeSession, sessionLoginArgs } from './session.js';

const NOW = Date.UTC(2026, 0, 10, 12);
const base = { D365_BASE_URL: 'https://x.sandbox.operations.dynamics.com', D365_SESSION_MAX_AGE_HOURS: 12 };

async function saved(cookies: unknown, ageHours = 1) {
  const dir = await mkdtemp(join(tmpdir(), 'sess-'));
  const path = join(dir, 'state.json');
  await writeFile(path, typeof cookies === 'string' ? cookies : JSON.stringify({ cookies, origins: [] }));
  const { utimes } = await import('node:fs/promises');
  const t = new Date(NOW - ageHours * 3_600_000);
  await utimes(path, t, t);
  return path;
}
const cookie = (over: object = {}) => ({ name: 'a', value: 'v', domain: 'x.sandbox.operations.dynamics.com', expires: -1, ...over });

describe('checkSession', () => {
  it('is off when unset', async () => {
    assert.equal((await checkSession({ ...base, D365_STORAGE_STATE: undefined }, NOW)).state, 'off');
  });
  it('reports a missing file', async () => {
    assert.equal((await checkSession({ ...base, D365_STORAGE_STATE: '/nope/state.json' }, NOW)).state, 'missing');
  });
  it('reports an unreadable file', async () => {
    assert.equal((await checkSession({ ...base, D365_STORAGE_STATE: await saved('not json') }, NOW)).state, 'unreadable');
  });
  it('is ok for fresh session cookies on the D365 host, without echoing cookie values', async () => {
    const s = await checkSession({ ...base, D365_STORAGE_STATE: await saved([cookie({ value: 'TOPSECRET' })]) }, NOW);
    assert.equal(s.state, 'ok');
    assert.ok(!JSON.stringify(s).includes('TOPSECRET'));
  });
  it('is expired when every dated cookie has expired', async () => {
    const p = await saved([cookie({ expires: NOW / 1000 - 60 })]);
    assert.equal((await checkSession({ ...base, D365_STORAGE_STATE: p }, NOW)).state, 'expired');
  });
  it('is expired when no cookie belongs to the D365 host', async () => {
    const p = await saved([cookie({ domain: '.other.example' })]);
    assert.equal((await checkSession({ ...base, D365_STORAGE_STATE: p }, NOW)).state, 'expired');
  });
  it('matches parent-domain cookies', async () => {
    const p = await saved([cookie({ domain: '.dynamics.com' })]);
    assert.equal((await checkSession({ ...base, D365_STORAGE_STATE: p }, NOW)).state, 'ok');
  });
  it('is stale past the max age', async () => {
    const p = await saved([cookie()], 30);
    assert.equal((await checkSession({ ...base, D365_STORAGE_STATE: p }, NOW)).state, 'stale');
  });
});

describe('checkSession F&O session cookie', () => {
  it('warns when only sign-in cookies are saved, and not when DynamicsOwinAuth is present', async () => {
    const without = await checkSession({ ...base, D365_STORAGE_STATE: await saved([cookie({ name: 'ESTSAUTH' })]) }, NOW);
    assert.equal(without.state, 'ok');
    assert.match(without.warning ?? '', /DynamicsOwinAuth/);
    const withIt = await checkSession({ ...base, D365_STORAGE_STATE: await saved([cookie({ name: 'DynamicsOwinAuth' })]) }, NOW);
    assert.equal(withIt.warning, undefined);
  });
  it('keeps the warning on a stale session and never echoes cookie values', async () => {
    const s = await checkSession({ ...base, D365_STORAGE_STATE: await saved([cookie({ name: 'x', value: 'TOPSECRET' })], 30) }, NOW);
    assert.equal(s.state, 'stale');
    assert.ok(s.warning);
    assert.ok(!JSON.stringify(s).includes('TOPSECRET'));
  });
});

describe('probeSession', () => {
  const headers = (location?: string) => new Headers(location ? { location } : {});
  const cfgFor = async (cookies: unknown) => ({ ...base, D365_STORAGE_STATE: await saved(cookies) });

  it('sends only cookies for the F&O host, without following redirects', async () => {
    const cfg = await cfgFor([cookie({ name: 'DynamicsOwinAuth', value: 'V1' }), cookie({ name: 'other', value: 'V2', domain: '.other.example' })]);
    let seen: RequestInit | undefined;
    const r = await probeSession(cfg, async (_u, init) => ((seen = init), { status: 200, headers: headers() }), NOW);
    assert.equal(r.state, 'live');
    assert.equal(seen?.redirect, 'manual');
    assert.equal((seen?.headers as Record<string, string>).cookie, 'DynamicsOwinAuth=V1');
    assert.ok(!JSON.stringify(r).includes('V1'));
  });
  it('reports signed-out when the host redirects to a Microsoft sign-in page', async () => {
    const cfg = await cfgFor([cookie({ name: 'DynamicsOwinAuth' })]);
    const r = await probeSession(cfg, async () => ({ status: 302, headers: headers('https://login.microsoftonline.com/tenant/oauth2/authorize?x=1') }), NOW);
    assert.equal(r.state, 'signed-out');
    assert.match(r.detail, /session-login/);
  });
  it('is unknown for other redirects, other statuses and network errors', async () => {
    const cfg = await cfgFor([cookie({ name: 'DynamicsOwinAuth' })]);
    assert.equal((await probeSession(cfg, async () => ({ status: 302, headers: headers('/somewhere') }), NOW)).state, 'unknown');
    assert.equal((await probeSession(cfg, async () => ({ status: 503, headers: headers() }), NOW)).state, 'unknown');
    assert.equal((await probeSession(cfg, async () => { throw new Error('boom'); }, NOW)).state, 'unknown');
  });
  it('makes no request when there are no usable cookies', async () => {
    const cfg = await cfgFor([cookie({ domain: '.other.example' })]);
    let called = false;
    const r = await probeSession(cfg, async () => ((called = true), { status: 200, headers: headers() }), NOW);
    assert.equal(r.state, 'signed-out');
    assert.equal(called, false);
  });
});

describe('using the saved session', () => {
  const cfg = (over: Partial<AppConfig>) =>
    ({ D365_BASE_URL: base.D365_BASE_URL, D365_COMPANY: 'USMF', LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', PW_HEADLESS: true, PW_BROWSER: 'chromium', LEARN_MCP_URL: 'u', ...over }) as AppConfig;

  it('does not require a password when a session file exists', async () => {
    const p = await saved([cookie()]);
    assert.deepEqual(validateForRun(cfg({ D365_STORAGE_STATE: p })), []);
  });
  it('still requires credentials when the session file is missing', () => {
    for (const c of [cfg({ D365_STORAGE_STATE: '/nope.json' }), cfg({})]) {
      const issues = validateForRun(c);
      assert.equal(issues.length, 1);
      assert.ok(issues[0].includes('D365_USERNAME') && issues[0].includes('D365_PASSWORD'));
    }
  });
  it('accepts configured credentials without a session file', () => {
    assert.deepEqual(validateForRun(cfg({ D365_USERNAME: 'u', D365_PASSWORD: 'p' })), []);
  });
  it('launches Playwright with the storage state only when a file is supplied', async () => {
    const args = (m: unknown) => (m as { specs: Map<string, { args: string[] }> }).specs.get('playwright')!.args;
    const off = args(buildDefaultManager(cfg({}), undefined));
    assert.ok(!off.includes('--storage-state') && !off.includes('--isolated'));
    const on = args(buildDefaultManager(cfg({}), '/tmp/s.json'));
    assert.deepEqual(on.slice(-3), ['--isolated', '--storage-state', '/tmp/s.json']);
  });
  it('tells the model about the session, with a password fallback only when configured', async () => {
    const p = await saved([cookie()]);
    assert.match(d365SystemGuidance(cfg({ D365_STORAGE_STATE: p })), /BLOCKED and say the saved session must be renewed/);
    assert.match(d365SystemGuidance(cfg({ D365_STORAGE_STATE: p, D365_USERNAME: 'u', D365_PASSWORD: 'p' })), /fall back to the credential steps/);
    assert.ok(!d365SystemGuidance(cfg({})).includes('saved, already signed-in'));
  });
  it('tells the model not to sign out', () => {
    assert.match(d365SystemGuidance(cfg({})), /Do not sign out/);
  });
  it('activeSessionFile ignores a missing file', () => {
    assert.equal(activeSessionFile({ D365_STORAGE_STATE: '/nope.json' }), undefined);
  });
});

describe('interactiveSessionLogin', () => {
  it('installs the browser, opens the D365 URL saving to the output path, and locks the file down', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'login-'));
    const out = join(dir, 'sub', 'state.json');
    const calls: string[][] = [];
    const run = async (_c: string, args: string[]) => {
      calls.push(args);
      if (args.includes('open')) await writeFile(out, '{"cookies":[]}', { mode: 0o644 });
      return 0;
    };
    await interactiveSessionLogin({ PW_BROWSER: 'chromium', D365_BASE_URL: base.D365_BASE_URL }, out, run);
    assert.deepEqual(calls[0], ['-y', 'playwright@latest', 'install', 'chromium']);
    assert.deepEqual(calls[1], sessionLoginArgs({ PW_BROWSER: 'chromium' }, base.D365_BASE_URL, out));
    if (process.platform !== 'win32') assert.equal((await stat(out)).mode & 0o777, 0o600);
  });
  it('fails clearly when the browser closes without saving', async () => {
    const out = join(await mkdtemp(join(tmpdir(), 'login-')), 'state.json');
    await assert.rejects(
      interactiveSessionLogin({ PW_BROWSER: 'chromium', D365_BASE_URL: base.D365_BASE_URL }, out, async () => 0),
      /No session was saved/,
    );
  });
});
