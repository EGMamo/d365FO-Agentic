import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startUiServer, type RunningUi } from './server.js';

let ui: RunningUi;
let cookie = '';

interface Reply { status: number; headers: Record<string, unknown>; body: string }
function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; auth?: boolean; write?: boolean } = {}): Promise<Reply> {
  const { body, headers = {}, auth = true, write = method !== 'GET' } = opts;
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { host: `127.0.0.1:${ui.port}`, ...headers };
    if (auth && cookie) h.cookie = cookie;
    if (write) h['x-requested-with'] = 'd365fo-ui';
    const data = body === undefined ? undefined : JSON.stringify(body);
    if (data) h['content-type'] = 'application/json';
    const req = request({ host: '127.0.0.1', port: ui.port, method, path, headers: h }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}
const json = (r: Reply): any => JSON.parse(r.body);

before(async () => {
  ui = await startUiServer({ home: await mkdtemp(join(tmpdir(), 'ui-')), port: 0 });
  const r = await call('GET', `/?token=${ui.token}`, { auth: false });
  assert.equal(r.status, 302);
  cookie = String(r.headers['set-cookie']).split(';')[0];
});
after(() => ui.close());

describe('settings web server', () => {
  it('listens on the loopback address only', () => {
    assert.equal((ui.server.address() as { address: string }).address, '127.0.0.1');
  });

  it('refuses requests without the token, with a wrong token, or with a foreign Host header', async () => {
    assert.equal((await call('GET', '/api/state', { auth: false })).status, 403);
    assert.equal((await call('GET', '/?token=wrong', { auth: false })).status, 403);
    assert.equal((await call('GET', '/api/state', { headers: { host: 'evil.example' } })).status, 403);
  });

  it('serves the page to a signed-in browser', async () => {
    const r = await call('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.body, /D365FO Agent/);
  });

  it('refuses writes from another origin or without the custom header', async () => {
    assert.equal((await call('POST', '/api/profiles', { body: { name: 'X' }, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call('POST', '/api/profiles', { body: { name: 'X' }, write: false })).status, 403);
  });

  it('creates, edits, masks, selects and deletes a profile', async () => {
    const created = await call('POST', '/api/profiles', { body: { name: 'Sandbox', entries: [{ key: 'D365_PASSWORD', value: 'hunter2!' }, { key: 'D365_COMPANY', value: 'USMF' }] } });
    assert.equal(created.status, 201);
    const read = await call('GET', '/api/profiles/Sandbox');
    assert.ok(!read.body.includes('hunter2'), 'secret is never sent to the browser');
    assert.equal(json(read).entries.length, 2);
    const saved = await call('PUT', '/api/profiles/Sandbox', { body: { entries: json(read).entries.concat([{ key: 'MY_CUSTOM', value: 'v' }]) } });
    assert.equal(saved.status, 200);
    assert.equal((await call('POST', '/api/profiles', { body: { name: 'sandbox', entries: [] } })).status, 409);
    assert.equal((await call('POST', '/api/active', { body: { name: 'Sandbox' } })).status, 200);
    const state = json(await call('GET', '/api/state'));
    assert.equal(state.active, 'Sandbox');
    assert.equal(state.profiles[0].active, true);
    assert.ok(state.catalog.length > 10);
    assert.equal((await call('DELETE', '/api/profiles/Sandbox')).status, 200);
    assert.equal(json(await call('GET', '/api/state')).active, null);
    assert.equal((await call('GET', '/api/profiles/Sandbox')).status, 404);
  });

  it('rejects path traversal in profile names', async () => {
    assert.equal((await call('GET', '/api/profiles/..%2F..%2Fetc%2Fpasswd')).status, 400);
  });
});

describe('run management', () => {
  // Stands in for the real CLI: echoes its arguments and the selected profile, then exits.
  const FAKE_CLI = [
    "import { setTimeout as sleep } from 'node:timers/promises';",
    "const args = process.argv.slice(2);",
    "console.log('ARGS ' + args.join(' '));",
    "console.log('PROFILE ' + (process.env.D365FO_PROFILE ?? 'none'));",
    "if (args.includes('--case') && args[args.indexOf('--case') + 1] === 'slow') await sleep(60000);",
    "else process.exitCode = args.includes('--dry-run') ? 0 : 3;",
  ].join('\n');

  let dir = '';
  let runUi: RunningUi;
  let base = '';
  let cookieHeader = '';
  let rcall: (path: string, init?: RequestInit, auth?: boolean) => Promise<Response>;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'd365ui-run-'));
    await writeFile(join(dir, 'cli.mjs'), FAKE_CLI);
    runUi = await startUiServer({ home: dir, port: 0, cliPath: join(dir, 'cli.mjs') });
    base = `http://127.0.0.1:${runUi.port}`;
    cookieHeader = `d365fo_ui=${runUi.token}`;
    rcall = (path, init = {}, auth = true) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const headers: Record<string, string> = {};
      if (auth) headers.cookie = cookieHeader;
      if (init.body) headers['content-type'] = 'application/json';
      if (method !== 'GET') headers['x-requested-with'] = 'd365fo-ui';
      return fetch(base + path, { ...init, redirect: 'manual', headers: { ...headers, ...(init.headers as Record<string, string>) } });
    };
  });
  after(async () => {
    await runUi.close();
    await rm(dir, { recursive: true, force: true });
  });

  const pollStatus = async (needle: string, timeoutMs = 5000): Promise<any> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = (await (await rcall('/api/run')).json()) as any;
      if (r && r.status === needle) return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error('timed out waiting for run status ' + needle);
  };

  it('reports no run before one is started and validates arguments', async () => {
    assert.equal(await (await rcall('/api/run')).text(), 'null');
    assert.equal((await rcall('/api/run', { method: 'POST', body: JSON.stringify({ source: 'devops', plan: '1; rm -rf /' }) })).status, 400);
    assert.equal((await rcall('/api/run', { method: 'POST', body: JSON.stringify({ source: 'local', local: 'cases', retries: 11 }) })).status, 400);
    assert.equal((await rcall('/api/run', { method: 'POST', body: JSON.stringify({ source: 'local', local: '' }) })).status, 400);
  });

  it('starts a run with the chosen options and records its output', async () => {
    const started = await rcall('/api/run', { method: 'POST', body: JSON.stringify({ source: 'local', local: 'cases', caseId: 'TC-1', dryRun: true, retries: 2 }) });
    assert.equal(started.status, 200);
    const r = await pollStatus('passed');
    assert.match(r.lines.join('\n'), /ARGS run --local cases --case TC-1 --dry-run --reloop-max-retries 2/);
    assert.match(r.lines.join('\n'), /PROFILE none/);
  });

  it('refuses a second run while busy and can stop the first', async () => {
    const first = await rcall('/api/run', { method: 'POST', body: JSON.stringify({ source: 'devops', plan: '8', suite: '9', caseId: 'slow' }) });
    assert.equal(first.status, 200);
    assert.equal((await rcall('/api/run', { method: 'POST', body: JSON.stringify({ source: 'local', local: 'x' }) })).status, 409);
    const stopped = await rcall('/api/run/stop', { method: 'POST', body: '{}' });
    assert.equal(stopped.status, 200);
    const r = await pollStatus('stopped');
    assert.equal(r.status, 'stopped');
  });
});
