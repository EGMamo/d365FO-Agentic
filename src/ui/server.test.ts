import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
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
