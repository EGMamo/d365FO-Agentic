import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { validateForRun, type AppConfig } from '../config/index.js';
import { buildDefaultManager } from '../mcp/registry.js';
import { d365SystemGuidance } from './guidance.js';
import { activeSessionFile, checkSession, interactiveSessionLogin, PLAYWRIGHT_SESSION_PACKAGE, probeBlocksRun, probeSession, sessionCommand, sessionLoginArgs, type ProbeFetch } from './session.js';

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
const cookie = (over: object = {}) => ({ name: 'DynamicsOwinAuth', value: 'v', domain: 'x.sandbox.operations.dynamics.com', expires: -1, ...over });

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
  it('warns, without failing, when only Entra cookies are present (no DynamicsOwinAuth)', async () => {
    const p = await saved([cookie({ name: 'ESTSAUTH' }), cookie({ name: 'ms-dyn-csrftoken' })]);
    const s = await checkSession({ ...base, D365_STORAGE_STATE: p }, NOW);
    assert.equal(s.state, 'ok');
    assert.match(s.warnings?.join(' ') ?? '', /DynamicsOwinAuth[\s\S]*session-login/);
  });
  it('ignores a DynamicsOwinAuth cookie that belongs to another host', async () => {
    const p = await saved([cookie({ domain: '.other.example' }), cookie({ name: 'ESTSAUTH' })]);
    const s = await checkSession({ ...base, D365_STORAGE_STATE: p }, NOW);
    assert.equal(s.state, 'ok');
    assert.match(s.warnings?.join(' ') ?? '', /DynamicsOwinAuth/);
  });
  it('warns, without failing, when ms-dyn-csrftoken is missing', async () => {
    const s = await checkSession({ ...base, D365_STORAGE_STATE: await saved([cookie()]) }, NOW);
    assert.equal(s.state, 'ok');
    assert.match(s.warnings?.[0] ?? '', /ms-dyn-csrftoken/);
    const full = await checkSession({ ...base, D365_STORAGE_STATE: await saved([cookie(), cookie({ name: 'ms-dyn-csrftoken' })]) }, NOW);
    assert.equal(full.warnings, undefined);
  });
  it('is stale past the max age', async () => {
    const p = await saved([cookie()], 30);
    assert.equal((await checkSession({ ...base, D365_STORAGE_STATE: p }, NOW)).state, 'stale');
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
    assert.match(d365SystemGuidance(cfg({ D365_STORAGE_STATE: p })), /Never sign out/);
    assert.ok(!d365SystemGuidance(cfg({})).includes('Never sign out'));
  });
  it('activeSessionFile ignores a missing file', () => {
    assert.equal(activeSessionFile({ D365_STORAGE_STATE: '/nope.json' }), undefined);
  });
});

describe('interactiveSessionLogin', () => {
  it('installs the browser, opens the D365 URL saving to the output path, and locks the file down', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'login-'));
    const out = join(dir, 'sub', 'state.json');
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args.includes('open')) await writeFile(out, '{"cookies":[]}', { mode: 0o644 });
      return 0;
    };
    await interactiveSessionLogin({ PW_BROWSER: 'chromium', D365_BASE_URL: base.D365_BASE_URL }, out, run);
    assert.deepEqual(calls[0], sessionCommand(['install', 'chromium']));
    assert.deepEqual(calls[1], sessionCommand(sessionLoginArgs({ PW_BROWSER: 'chromium' }, base.D365_BASE_URL, out)));
    if (process.platform !== 'win32') assert.equal((await stat(out)).mode & 0o777, 0o600);
  });
  it('uses the bundled Electron/Node CLI without npx, and pins the source-checkout fallback', () => {
    const args = sessionLoginArgs({ PW_BROWSER: 'chromium' }, base.D365_BASE_URL, '/tmp/session with spaces.json');
    assert.deepEqual(sessionCommand(args, () => '/app/node_modules/playwright/cli.js'), {
      command: process.execPath, args: ['/app/node_modules/playwright/cli.js', ...args],
    });
    assert.deepEqual(sessionCommand(args, () => undefined), { command: 'npx', args: ['-y', PLAYWRIGHT_SESSION_PACKAGE, ...args] });
    assert.ok(!PLAYWRIGHT_SESSION_PACKAGE.includes('latest'));
  });
  it('fails clearly when the browser closes without saving', async () => {
    const out = join(await mkdtemp(join(tmpdir(), 'login-')), 'state.json');
    await assert.rejects(
      interactiveSessionLogin({ PW_BROWSER: 'chromium', D365_BASE_URL: base.D365_BASE_URL }, out, async () => 0),
      /No session was saved/,
    );
  });
});

describe('probeSession', () => {
  const reply = (status: number, location?: string): ProbeFetch => async () => ({ status, headers: { get: (n) => (n === 'location' && location ? location : null) } });
  const cfgFor = async () => ({ ...base, D365_STORAGE_STATE: await saved([cookie({ value: 'TOPSECRET' }), cookie({ name: 'ESTSAUTH', domain: '.login.microsoftonline.com', value: 'OTHER' })]) });

  it('is skipped without a saved session', async () => {
    assert.equal((await probeSession({ ...base, D365_STORAGE_STATE: undefined })).state, 'skipped');
  });
  it('is expired when redirected to the Microsoft sign-in page', async () => {
    const r = await probeSession(await cfgFor(), reply(302, 'https://login.microsoftonline.com/common/oauth2/authorize?x=1'));
    assert.equal(r.state, 'expired');
    assert.match(r.detail, /session-login/);
  });
  it('is live on 200 or on a redirect within the environment', async () => {
    assert.equal((await probeSession(await cfgFor(), reply(200))).state, 'live');
    assert.equal((await probeSession(await cfgFor(), reply(302, '/?cmp=USMF'))).state, 'live');
  });
  it('is unreachable when the request fails, and never echoes cookie values', async () => {
    const r = await probeSession(await cfgFor(), async () => { throw new Error('ECONNRESET'); });
    assert.equal(r.state, 'unreachable');
    assert.ok(!JSON.stringify(r).includes('TOPSECRET'));
  });
  it('sends only cookies for the F&O host and never follows redirects', async () => {
    let seen: { cookie?: string; redirect?: string } = {};
    await probeSession(await cfgFor(), async (_u, init) => { seen = { cookie: init.headers.cookie, redirect: init.redirect }; return { status: 200, headers: { get: () => null } }; });
    assert.equal(seen.cookie, 'DynamicsOwinAuth=TOPSECRET');
    assert.equal(seen.redirect, 'manual');
  });
});

describe('probeBlocksRun (run --probe-session)', () => {
  it('stops the run for an expired session or an unreachable host, with what to do', () => {
    assert.match(probeBlocksRun({ state: 'expired', detail: 'x' }) ?? '', /session-login/);
    assert.match(probeBlocksRun({ state: 'unreachable', detail: 'x' }) ?? '', /unreachable/);
  });

  it('lets the run start when the session is live or there is nothing to probe', () => {
    assert.equal(probeBlocksRun({ state: 'live', detail: 'x' }), undefined);
    assert.equal(probeBlocksRun({ state: 'skipped', detail: 'x' }), undefined);
  });
});
