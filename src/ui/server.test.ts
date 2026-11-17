import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { startUiServer, type RunningUi, type ToolActionApproval } from './server.js';
import { ProfileStore } from '../profiles/store.js';
import { RunHistory } from './history.js';
import { TestCaseFiles } from '../testing/store.js';

it('Tests and Chat read the same Azure DevOps suite through the existing REST client', async () => {
  const remote = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url?.includes('/_apis/test/Plans/')
      ? { value: [{ testCase: { id: '123' } }] }
      : { value: [{ id: 123, fields: { 'System.Title': 'Read supplier', 'Microsoft.VSTS.TCM.Steps': '<steps><step id="1"><parameterizedString>Open suppliers</parameterizedString><parameterizedString>Supplier list</parameterizedString></step></steps>' } }] }));
  });
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
  const home = await mkdtemp(join(tmpdir(), 'devops-selection-'));
  const store = new ProfileStore(home);
  await store.write('UAT', [{ key: 'AZDO_ORG_URL', value: `http://127.0.0.1:${(remote.address() as AddressInfo).port}/org` }, { key: 'AZDO_PROJECT', value: 'Finance' }, { key: 'AZDO_PAT', value: 'fake-test-pat' }], 'create');
  await store.setActive('UAT');
  const server = await startUiServer({ home, port: 0, childEnv: () => ({}) });
  try {
    const query = '?plan=1&suite=2';
    const cases = await (await fetch(server.url + 'api/cases' + query, { headers: { Cookie: `d365fo_ui=${server.token}` } })).json() as any[];
    assert.equal(cases[0].id, '123');
    assert.equal(cases[0].steps[0].expected, 'Supplier list');
    const chat = await (await fetch(server.url + 'tools/testcases' + query, { headers: { Authorization: `Bearer ${server.toolToken}` } })).json();
    assert.deepEqual(chat, cases);
    assert.equal((await fetch(server.url + 'api/cases?plan=1', { headers: { Cookie: `d365fo_ui=${server.token}` } })).status, 400);
  } finally {
    await server.close();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
  }
});

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

  it('rejects malformed and multibyte credentials without server errors', async () => {
    const multibyte = 'é'.repeat(ui.token.length);
    for (const value of ['%', '%E0%A4%A', encodeURIComponent(multibyte)]) {
      assert.equal((await call('GET', '/api/state', {
        auth: false, headers: { cookie: `d365fo_ui=${value}` },
      })).status, 403);
    }
    assert.equal((await call('GET', `/?token=${encodeURIComponent(multibyte)}`, { auth: false })).status, 403);
    assert.equal((await call('GET', '/tools/profiles', {
      auth: false, headers: { authorization: `Bearer ${'é'.repeat(ui.toolToken.length)}` },
    })).status, 401);
    assert.equal((await call('GET', '/api/state')).status, 200);
  });

  it('serves the page to a signed-in browser', async () => {
    const r = await call('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.body, /D365FO Agent/);
  });

  it('serves the page scripts and styles to a signed-in browser only', async () => {
    for (const [path, type] of [['/app.js', /javascript/], ['/app.css', /css/], ['/icon.svg', /svg/]] as const) {
      const r = await call('GET', path);
      assert.equal(r.status, 200, path);
      assert.match(String(r.headers['content-type']), type);
      assert.equal((await call('GET', path, { auth: false })).status, 403);
    }
    assert.equal((await call('GET', '/server.js')).status, 404);
  });

  it('describes each environment for its card without revealing secrets', async () => {
    assert.equal((await call('POST', '/api/profiles', { body: { name: 'Card', entries: [{ key: 'D365_BASE_URL', value: 'https://card.sandbox.operations.dynamics.com' }, { key: 'D365_USERNAME', value: 'u' }, { key: 'D365_PASSWORD', value: 'sekret-pw' }, { key: 'D365_COMPANY', value: 'GBSI' }] } })).status, 201);
    const r = await call('GET', '/api/state');
    assert.ok(!r.body.includes('sekret-pw'));
    const card = json(r).profiles.find((p: any) => p.name === 'Card');
    assert.deepEqual([card.host, card.company, card.signIn, card.devops, card.check], ['card.sandbox.operations.dynamics.com', 'GBSI', 'password', false, null]);
    assert.equal((await call('DELETE', '/api/profiles/Card')).status, 200);
  });

  it('closes each connection after the response, so Safari never reuses a socket the server already dropped', async () => {
    for (const r of [await call('GET', '/api/health', { auth: false }), await call('PUT', '/api/profiles/none', { body: { entries: [] } })]) {
      assert.equal(r.headers.connection, 'close');
    }
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
    "console.log('DRY ' + process.env.AGENT_DRY_RUN);",
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
    runUi = await startUiServer({ home: dir, port: 0, cliPath: join(dir, 'cli.mjs'), root: dir });
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
    const started = await rcall('/api/run', { method: 'POST', body: JSON.stringify({ source: 'local', local: 'cases', caseId: 'TC-1', dryRun: true }) });
    assert.equal(started.status, 200);
    const r = await pollStatus('passed');
    assert.match(r.lines.join('\n'), /ARGS run --local cases --case TC-1 --dry-run --fail-on failed,blocked/);
    assert.match(r.lines.join('\n'), /PROFILE none/);
    assert.match(r.lines.join('\n'), /DRY true/);
  });

  it('passes the selected case IDs to the single shared execution path', async () => {
    const started = await rcall('/api/run', { method: 'POST', body: JSON.stringify({ source: 'local', local: 'cases', cases: ['TC-1', 'TC-2'], dryRun: true }) });
    assert.equal(started.status, 200);
    const r = await pollStatus('passed');
    assert.match(r.lines.join('\n'), /--case TC-1,TC-2/);
    assert.doesNotMatch(r.lines.join('\n'), /--model|reloop/);
  });

  it('hands the page only the log lines it has not seen, with the run progress', async () => {
    const started = await rcall('/api/run', { method: 'POST', body: JSON.stringify({ source: 'local', local: 'cases', dryRun: true }) });
    assert.equal(started.status, 200);
    const all = await pollStatus('passed');
    assert.equal(all.from, 0);
    assert.equal(all.lineCount, all.lines.length);
    assert.ok(all.progress);
    const later = (await (await rcall('/api/run?since=' + (all.lineCount - 1))).json()) as any;
    assert.deepEqual(later.lines, all.lines.slice(-1));
    assert.equal(later.from, all.lineCount - 1);
    const none = (await (await rcall('/api/run?since=' + all.lineCount)).json()) as any;
    assert.deepEqual(none.lines, []);
    const bogus = (await (await rcall('/api/run?since=999999')).json()) as any;
    assert.equal(bogus.from, 0, 'an unknown position starts over');
  });

  it('refuses a second run while busy and can stop the first', async () => {
    const first = await rcall('/api/run', { method: 'POST', body: JSON.stringify({ source: 'devops', plan: '8', suite: '9', caseId: 'slow' }) });
    assert.equal(first.status, 200);
    assert.equal((await rcall('/api/run', { method: 'POST', body: JSON.stringify({ source: 'local', local: 'x' }) })).status, 409);
    const switched = await rcall('/api/active', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(switched.status, 409, 'the profile cannot change while a run is in progress');
    assert.match(((await switched.json()) as any).error, /run is in progress/);
    const stopped = await rcall('/api/run/stop', { method: 'POST', body: '{}' });
    assert.equal(stopped.status, 200);
    const r = await pollStatus('stopped');
    assert.equal(r.status, 'stopped');
  });
});

describe('test-case editor, run history and upload', () => {
  // Fake CLI: `run` writes a results.json like the real one, `upload` prints the line the real one prints.
  const FAKE_CLI = [
    "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "let dir = 'reports';",
    "try { const id = /^PROFILE_ID=(\\w+)/m.exec(readFileSync(process.env.D365FO_AGENT_HOME + '/profiles/' + process.env.D365FO_PROFILE + '.env', 'utf8'))?.[1]; if (id) dir = 'reports/' + id; } catch {}",
    "if (args[0] === 'run') {",
    "  mkdirSync(dir, { recursive: true });",
    "  writeFileSync(dir + '/results.json', JSON.stringify([{ testCaseId: 'TC-1', title: 'One', outcome: 'passed', steps: [], durationMs: 5 }, { testCaseId: 'TC-2', title: 'Two', outcome: 'failed', steps: [], durationMs: 5 }]));",
    "  writeFileSync(dir + '/report.html', '<html>report</html>');",
    "  process.exitCode = 1;",
    "} else if (args[0] === 'upload') {",
    "  console.log('INPUT ' + args[2] + ' PLAN ' + (args[4] ?? '-'));",
    "  console.log('UPLOAD_PROFILE ' + process.env.D365FO_PROFILE);",
    "  console.log('Uploaded run #42: https://dev.azure.com/org/p/_testManagement/runs?runId=42');",
    "}",
  ].join('\n');

  let dir = '';
  let hui: RunningUi;
  let hcall: (path: string, init?: RequestInit) => Promise<Response>;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'd365ui-hist-'));
    await writeFile(join(dir, 'cli.mjs'), FAKE_CLI);
    hui = await startUiServer({ home: join(dir, 'home'), port: 0, cliPath: join(dir, 'cli.mjs'), root: dir });
    hcall = (path, init = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const headers: Record<string, string> = { cookie: `d365fo_ui=${hui.token}` };
      if (init.body) headers['content-type'] = 'application/json';
      if (method !== 'GET') headers['x-requested-with'] = 'd365fo-ui';
      return fetch(`http://127.0.0.1:${hui.port}${path}`, { ...init, headers });
    };
  });
  after(async () => {
    await hui.close();
    await rm(dir, { recursive: true, force: true });
  });
  const waitFor = async (pred: (r: any) => boolean): Promise<any> => {
    for (let i = 0; i < 100; i++) {
      const r = (await (await hcall('/api/run')).json()) as any;
      if (r && pred(r)) return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error('timed out');
  };

  it('creates, lists, edits and deletes test-case files inside the project folder only', async () => {
    const tc = { title: 'Create vendor', module: 'Accounts payable', steps: [{ action: 'Open vendors', expected: 'List shown' }, { action: 'Click New' }] };
    const created = await hcall('/api/testcases?dir=cases', { method: 'PUT', body: JSON.stringify({ testCase: tc }) });
    assert.equal(created.status, 200);
    const { file } = (await created.json()) as any;
    assert.equal(file, 'create-vendor.json');
    assert.equal((await hcall('/api/testcases?dir=cases', { method: 'PUT', body: JSON.stringify({ testCase: tc }) })).status, 409, 'same id is refused');
    const list = (await (await hcall('/api/testcases?dir=cases')).json()) as any[];
    assert.deepEqual(list.map((c) => [c.file, c.id, c.steps]), [['create-vendor.json', 'CREATE-VENDOR', 2]]);
    const edited = await hcall(`/api/testcases?dir=cases&file=${file}`, { method: 'PUT', body: JSON.stringify({ testCase: { ...tc, id: 'TC-V1', steps: [{ action: 'Only step' }] } }) });
    assert.equal(edited.status, 200);
    const read = (await (await hcall(`/api/testcases?dir=cases&file=${file}`)).json()) as any;
    assert.deepEqual([read.id, read.steps], ['TC-V1', [{ index: 1, action: 'Only step' }]]);
    assert.equal((await hcall('/api/testcases?dir=cases', { method: 'PUT', body: JSON.stringify({ testCase: { title: 'x', steps: [] } }) })).status, 400);
    assert.equal((await hcall('/api/testcases?dir=../..')).status, 400);
    assert.equal((await hcall('/api/testcases?dir=cases&file=..%2F..%2Fx.json')).status, 400);
    assert.equal((await hcall(`/api/testcases?dir=cases&file=${file}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual(await (await hcall('/api/testcases?dir=cases')).json(), []);
  });

  it('keeps each finished run in the history and uploads one to Azure DevOps on request', async () => {
    assert.equal((await hcall('/api/run', { method: 'POST', body: JSON.stringify({ source: 'local', local: 'cases' }) })).status, 200);
    await waitFor((r) => r.status === 'failed' && r.lines.some((l: string) => l.startsWith('Saved to run history')));
    const runs = (await (await hcall('/api/history')).json()) as any[];
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].totals, { total: 2, passed: 1, failed: 1, blocked: 0, skipped: 0 });
    const id = runs[0].id;
    assert.match(await (await hcall(`/report?run=${id}`)).text(), /report/);
    const junit = await hcall(`/download/results.json?run=${id}`);
    assert.match(String(junit.headers.get('content-disposition')), /attachment/);
    assert.equal((await hcall('/report?run=nope')).status, 404);

    assert.equal((await hcall(`/api/history/${id}/upload`, { method: 'POST', body: JSON.stringify({ plan: '1;x' }) })).status, 400);
    assert.equal((await hcall(`/api/history/${id}/upload`, { method: 'POST', body: JSON.stringify({ plan: '77' }) })).status, 200);
    const up = await waitFor((r) => r.kind === 'upload' && r.status === 'passed');
    assert.match(up.lines.join('\n'), /INPUT .*history.*results\.json PLAN 77/);
    let meta: any;
    for (let i = 0; i < 50 && !meta?.upload; i++) {
      meta = ((await (await hcall('/api/history')).json()) as any[])[0];
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.deepEqual([meta.upload.runId, meta.upload.url], [42, 'https://dev.azure.com/org/p/_testManagement/runs?runId=42']);
    assert.equal((await (await hcall('/api/history')).json() as any[]).length, 1, 'an upload is not a new run');
    assert.equal((await hcall(`/api/history/${id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual(await (await hcall('/api/history')).json(), []);
  });

  it('uploads a run with the profile it belongs to, not the one in use now, and keeps each profile\'s runs apart', async () => {
    for (const name of ['Alpha', 'Beta']) assert.equal((await hcall('/api/profiles', { method: 'POST', body: JSON.stringify({ name, entries: [] }) })).status, 201);
    assert.equal((await hcall('/api/active', { method: 'POST', body: JSON.stringify({ name: 'Alpha' }) })).status, 200);
    assert.equal((await hcall('/api/run', { method: 'POST', body: JSON.stringify({ source: 'local', local: 'cases' }) })).status, 200);
    await waitFor((r) => r.status === 'failed' && r.lines.some((l: string) => l.startsWith('Saved to run history')));
    const [run] = (await (await hcall('/api/history')).json()) as any[];
    assert.equal(run.profile, 'Alpha');
    assert.ok(run.profileId);
    assert.equal((await hcall('/api/active', { method: 'POST', body: JSON.stringify({ name: 'Beta' }) })).status, 200);
    assert.equal((await hcall(`/api/history/${run.id}/upload`, { method: 'POST', body: JSON.stringify({}) })).status, 200);
    const up = await waitFor((r) => r.kind === 'upload' && r.status === 'passed');
    assert.match(up.lines.join('\n'), /UPLOAD_PROFILE Alpha/);
    // Renamed profile: the run still finds it by id.
    assert.equal((await hcall('/api/profiles/Alpha', { method: 'PATCH', body: JSON.stringify({ name: 'Alpha 2' }) })).status, 200);
    assert.equal((await hcall(`/api/history/${run.id}/upload`, { method: 'POST', body: JSON.stringify({}) })).status, 200);
    const again = await waitFor((r) => r.kind === 'upload' && r.status === 'passed' && r.lines.some((l: string) => l.includes('Alpha 2')));
    assert.match(again.lines.join('\n'), /UPLOAD_PROFILE Alpha 2/);
  });
});

describe('OpenAPI integration endpoint', () => {
  const FAKE_CLI = [
    "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "let dir = 'reports';",
    "try { const id = /^PROFILE_ID=(\\w+)/m.exec(readFileSync(process.env.D365FO_AGENT_HOME + '/profiles/' + process.env.D365FO_PROFILE + '.env', 'utf8'))?.[1]; if (id) dir = 'reports/' + id; } catch {}",
    "if (args[0] === 'run') {",
    "  mkdirSync(dir, { recursive: true });",
    "  writeFileSync(dir + '/results.json', JSON.stringify([{ testCaseId: 'TC-1', title: 'One', outcome: 'passed', steps: [], durationMs: 5 }, { testCaseId: 'TC-2', title: 'Two', outcome: 'failed', failureCategory: 'assertion', steps: [{ index: 2, status: 'failed', errorMessage: 'Save button missing', durationMs: 1 }], durationMs: 5 }]));",
    "  console.log('ran ' + args.join(' '));",
    "  console.log('Running 2 test case(s).');",
    "} else if (args[0] === 'upload') {",
    "  console.log('Uploaded run #7: https://dev.azure.com/org/p/_testManagement/runs?runId=7');",
    "}",
  ].join('\n');

  let dir = '';
  let tui: RunningUi;
  // fetch() ignores a custom Host header, so the Docker-style Host checks go through node:http.
  const raw = (path: string, headers: Record<string, string>): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: tui.port, path, headers }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      });
      req.on('error', reject);
      req.end();
    });
  let tcall: (path: string, init?: RequestInit & { key?: string | null }) => Promise<Response>;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'd365ui-tools-'));
    await writeFile(join(dir, 'cli.mjs'), FAKE_CLI);
    const devopsClient = () => ({
      listPlans: async () => [{ id: '10', name: 'Regression', rootSuiteId: '11' }],
      listSuites: async (plan: string) => {
        if (plan === '404') throw new Error('Azure DevOps 404 Not Found: no such plan\n{"details":1}');
        return [{ id: '11', name: 'Root' }, { id: '12', name: 'AP', parentId: '11' }];
      },
    });
    tui = await startUiServer({ home: join(dir, 'home'), port: 0, cliPath: join(dir, 'cli.mjs'), root: dir, devopsClient, approveToolAction: async () => true });
    tcall = (path, init = {}) => {
      const { key = tui.toolToken, ...rest } = init;
      const headers: Record<string, string> = {};
      if (key !== null) headers.authorization = `Bearer ${key}`;
      if (rest.body) headers['content-type'] = 'application/json';
      return fetch(`http://127.0.0.1:${tui.port}/tools${path}`, { ...rest, headers });
    };
  });
  after(async () => {
    await tui.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('publishes an OpenAPI document without a key, and refuses every web page origin', async () => {
    const r = await tcall('/openapi.json', { key: null });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    const spec = (await r.json()) as any;
    const docker = await raw('/tools/openapi.json', { host: `host.docker.internal:${tui.port}` });
    assert.equal(JSON.parse(docker.body).servers[0].url, `http://host.docker.internal:${tui.port}/tools`, 'server URL follows the integration client host header');
    const viaDocker = await raw('/tools/profiles', { host: `host.docker.internal:${tui.port}`, authorization: `Bearer ${tui.toolToken}` });
    assert.equal(viaDocker.status, 200);
    const ops = Object.values(spec.paths).flatMap((p: any) => Object.values(p).map((o: any) => o.operationId));
    assert.deepEqual(ops.sort(), [
      'check_setup', 'compare_runs', 'get_results', 'get_run', 'list_devops_plans', 'list_devops_suites', 'list_profiles', 'list_runs', 'list_test_cases', 'read_test_case', 'rerun_failed', 'start_run', 'stop_run', 'upload_run', 'use_profile',
    ]);
    const pre = await fetch(`http://127.0.0.1:${tui.port}/tools/runs`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:3000', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 403, 'even a local page gets no preflight');
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    const local = await fetch(`http://127.0.0.1:${tui.port}/tools/profiles`, { headers: { origin: `http://127.0.0.1:${tui.port}`, authorization: `Bearer ${tui.toolToken}` } });
    assert.equal(local.status, 403, 'a page holding the token is still refused');
    const foreign = await fetch(`http://127.0.0.1:${tui.port}/tools/profiles`, { headers: { origin: 'https://untrusted.example', authorization: `Bearer ${tui.toolToken}` } });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  });

  it('refuses tool calls without the right key, and the browser cookie token is not accepted', async () => {
    assert.equal((await tcall('/profiles', { key: null })).status, 401);
    assert.equal((await tcall('/profiles', { key: 'wrong' })).status, 401);
    assert.equal((await tcall('/profiles', { key: tui.token })).status, 401);
    assert.notEqual(tui.toolToken, tui.token);
  });

  it('keeps the app itself closed to non-loopback Host headers', async () => {
    assert.equal((await raw('/api/state', { host: `host.docker.internal:${tui.port}`, cookie: `d365fo_ui=${tui.token}` })).status, 403);
    assert.equal((await raw('/api/state', { host: `127.0.0.1:${tui.port}`, cookie: `d365fo_ui=${tui.token}` })).status, 200);
  });

  it('lists and selects profiles without revealing their values', async () => {
    const home = join(dir, 'home');
    const { ProfileStore } = await import('../profiles/store.js');
    await new ProfileStore(home).write('UAT', [
      { key: 'D365_PASSWORD', value: 'hunter2!' }, { key: 'D365_BASE_URL', value: 'https://uat.sandbox.operations.dynamics.com' },
      { key: 'AZDO_ORG_URL', value: 'https://dev.azure.com/org' }, { key: 'AZDO_PROJECT', value: 'p' },
    ], 'create');
    assert.equal((await tcall('/profiles/active', { method: 'POST', body: JSON.stringify({ name: 'Nope' }) })).status, 404);
    assert.equal((await tcall('/profiles/active', { method: 'POST', body: JSON.stringify({ name: 'UAT' }) })).status, 200);
    const r = await tcall('/profiles');
    const text = await r.text();
    assert.ok(!text.includes('hunter2'));
    assert.equal(JSON.parse(text).active, 'UAT');
  });

  it('checks the active environment', async () => {
    const check = (await (await tcall('/setup/check', { method: 'POST' })).json()) as any;
    assert.equal(check.profile, 'UAT');
    assert.equal(typeof check.output, 'string');
  });

  it('allows chat to read cases, with writing reserved for the Tests screen', async () => {
    const { TestCaseFiles } = await import('../testing/store.js');
    const saved = await new TestCaseFiles(dir).save('cases', { title: 'Post invoice', steps: [{ action: 'Open invoice journal', expected: 'Journal list shown' }] });
    assert.equal((await tcall('/testcases?dir=cases', { method: 'PUT', body: '{}' })).status, 404);
    assert.deepEqual(((await (await tcall('/testcases?dir=cases')).json()) as any[]).map((c) => c.title), ['Post invoice']);
    assert.equal(((await (await tcall(`/testcases/file?dir=cases&file=${saved.file}`)).json()) as any).steps.length, 1);
    assert.equal((await tcall('/testcases?dir=../..')).status, 400);
  });

  it('lists Azure DevOps test plans and suites for the profile in use, and reports a refusal in one line', async () => {
    assert.deepEqual(await (await tcall('/devops/plans')).json(), { plans: [{ id: '10', name: 'Regression', rootSuiteId: '11' }] });
    assert.deepEqual(((await (await tcall('/devops/plans/10/suites')).json()) as any).suites.map((x: any) => x.id), ['11', '12']);
    assert.equal((await tcall('/devops/plans/1%3Bx/suites')).status, 400);
    const bad = await tcall('/devops/plans/404/suites');
    assert.equal(bad.status, 502);
    assert.equal(((await bad.json()) as any).error, 'Azure DevOps could not be read: Azure DevOps 404 Not Found: no such plan');
  });

  it('starts a run, waits for it, summarises results and uploads it from the history', async () => {
    for (const id of ['TC-1', 'TC-2']) await new TestCaseFiles(dir).save('cases', { id, title: id, steps: [{ action: 'Read a list' }] });
    assert.equal(((await (await tcall('/results')).json()) as any).error !== undefined, true);
    assert.equal((await tcall('/runs', { method: 'POST', body: JSON.stringify({ source: 'devops', plan: '1;x' }) })).status, 400);
    assert.equal((await tcall('/runs', { method: 'POST', body: JSON.stringify({ source: 'local', local: 'cases', dryRun: true }) })).status, 200);
    // One call waits for the run to end and hands back its results, so the chat needs no second call.
    const followed = (await (await tcall('/runs/current?waitSeconds=30&tail=5')).json()) as any;
    const run = followed.run;
    assert.equal(run.status, 'passed');
    assert.ok(run.log.some((l: string) => /ran run --local cases --dry-run/.test(l)));
    assert.equal(run.progress.total, 2);
    assert.deepEqual(followed.results.totals, { total: 2, passed: 1, failed: 1, blocked: 0, skipped: 0 });
    assert.match(followed.next, /finished and its results are included/);
    const results = (await (await tcall('/results')).json()) as any;
    assert.deepEqual(results.totals, { total: 2, passed: 1, failed: 1, blocked: 0, skipped: 0 });
    assert.deepEqual([results.cases[1].reason, results.cases[1].failedStep, results.cases[1].category], ['Save button missing', 2, 'assertion']);
    assert.match(results.cases[1].hint, /product defect/);
    assert.deepEqual(results.triage.map((t: any) => [t.category, t.cases]), [['assertion', 1]]);

    let runs: any[] = [];
    for (let i = 0; i < 50 && !runs.length; i++) {
      runs = ((await (await tcall('/history')).json()) as any).runs;
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.equal(runs.length, 1);
    assert.equal(((await (await tcall(`/results?run=${runs[0].id}`)).json()) as any).totals.total, 2);
    assert.equal((await tcall('/history/20990101-000000-1/upload', { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await tcall(`/history/${runs[0].id}/upload`, { method: 'POST', body: JSON.stringify({ plan: '5' }) })).status, 200);
    const up = ((await (await tcall('/runs/current?waitSeconds=10')).json()) as any).run;
    assert.deepEqual([up.kind, up.status], ['upload', 'passed']);
    assert.equal((await tcall('/runs/current/stop', { method: 'POST' })).status, 200);
  });

  it('reruns only the failed cases of a run, from its own source, and compares runs', async () => {
    const runs = ((await (await tcall('/history')).json()) as any).runs;
    const first = runs[0].id;
    assert.equal((await tcall(`/history/${first}/compare`)).status, 404, 'nothing earlier to compare with');
    const rerun = (await (await tcall(`/history/${first}/rerun`, { method: 'POST', body: '{}' })).json()) as any;
    assert.deepEqual(rerun.cases, ['TC-2']);
    const followed = (await (await tcall('/runs/current?waitSeconds=30&tail=5')).json()) as any;
    assert.ok(followed.run.log.some((l: string) => /ran run --local cases --case TC-2 --fail-on/.test(l)), followed.run.log.join('\n'));
    let second: string | undefined;
    for (let i = 0; i < 50 && !second; i++) {
      second = ((await (await tcall('/history')).json()) as any).runs.find((r: any) => r.id !== first)?.id;
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.ok(second);
    const cmp = (await (await tcall(`/history/${second}/compare`)).json()) as any;
    assert.equal(cmp.previous, first);
    assert.deepEqual([cmp.fixed, cmp.regressed, cmp.stillFailing, cmp.unchanged], [[], [], ['TC-2'], 1]);
    assert.equal((await tcall('/history/20990101-000000-1/rerun', { method: 'POST', body: '{}' })).status, 404);
  });
});

describe('settings handed to the commands the app starts', () => {
  // Stands in for the real CLI: reports which settings it can see in its environment.
  const FAKE_CLI = "console.log('PROFILE=' + process.env.D365FO_PROFILE + ' FROM_FILE=' + (process.env.D365_BASE_URL ?? 'unset') + ' REAL=' + (process.env.REAL_VAR ?? 'unset'));";
  let dir = '';
  let envUi: RunningUi;
  const ecall = (path: string, method = 'GET', body?: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${envUi.port}${path}`, {
      method,
      headers: { cookie: `d365fo_ui=${envUi.token}`, 'x-requested-with': 'd365fo-ui', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'd365ui-env-'));
    await writeFile(join(dir, 'cli.mjs'), FAKE_CLI);
    // The app itself read D365_BASE_URL from its own settings file; REAL_VAR came from the real environment.
    const appEnv = { ...process.env, D365_BASE_URL: 'https://stale.example', REAL_VAR: 'kept' };
    const childEnv = (): NodeJS.ProcessEnv => {
      const { D365_BASE_URL: _fromFile, ...rest } = appEnv;
      return rest;
    };
    envUi = await startUiServer({ home: join(dir, 'home'), port: 0, cliPath: join(dir, 'cli.mjs'), root: dir, childEnv });
    assert.equal((await ecall('/api/profiles', 'POST', { name: 'Other', entries: [{ key: 'D365_BASE_URL', value: 'https://other.example' }] })).status, 201);
  });
  after(async () => {
    await envUi.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('does not pass on what the app loaded from its own settings file, so the chosen profile is the one read', async () => {
    const check = (await (await ecall('/api/profiles/Other/check', 'POST')).json()) as { output: string };
    assert.equal(check.output, 'PROFILE=Other FROM_FILE=unset REAL=kept');

    assert.equal((await ecall('/api/active', 'POST', { name: 'Other' })).status, 200);
    assert.equal((await ecall('/api/run', 'POST', { source: 'local', local: 'cases', dryRun: true })).status, 200);
    let lines: string[] = [];
    for (let i = 0; i < 100 && !lines.some((l) => l.startsWith('PROFILE=')); i++) {
      await new Promise((r) => setTimeout(r, 50));
      lines = ((await (await ecall('/api/run')).json()) as { lines: string[] }).lines;
    }
    assert.ok(lines.includes('PROFILE=Other FROM_FILE=unset REAL=kept'), lines.join(' | '));
  });
});

describe('atomic job reservations and native tool approval', () => {
  let dir: string;
  let home: string;
  let reportDir: string;
  let savedId: string;
  let server: RunningUi | undefined;
  const body = { source: 'local', local: 'cases' };
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'job-lock-'));
    home = join(dir, 'home');
    const store = new ProfileStore(home);
    for (const name of ['Alpha', 'Beta']) await store.write(name, [
      { key: 'D365_BASE_URL', value: `https://${name.toLowerCase()}.sandbox.operations.dynamics.com` },
      { key: 'D365_COMPANY', value: 'GBSI' }, { key: 'AZDO_ORG_URL', value: 'https://dev.azure.com/example' },
      { key: 'AZDO_PROJECT', value: 'Finance' }, { key: 'AZDO_TEST_PLAN_ID', value: '7' },
    ], 'create');
    await store.setActive('Alpha');
    const profileId = await store.idOf('Alpha');
    reportDir = join(dir, 'reports', profileId);
    await mkdir(reportDir, { recursive: true });
    await writeFile(join(reportDir, 'results.json'), JSON.stringify([
      { testCaseId: 'TC-1', title: 'One', outcome: 'passed', steps: [], durationMs: 1 },
      { testCaseId: 'TC-2', title: 'Two', outcome: 'failed', steps: [], durationMs: 1 },
    ]));
    savedId = (await new RunHistory(async () => reportDir).record({
      profile: 'Alpha', profileId, status: 'failed', args: ['run', '--local', 'cases'], startedAt: new Date(Date.now() - 5000).toISOString(),
    }, 41)).id;
    for (const id of ['TC-1', 'TC-2']) await new TestCaseFiles(dir).save('cases', { id, title: id, steps: [{ action: 'Read a list' }] });
    await writeFile(join(dir, 'cli.mjs'), [
      "import { appendFileSync, existsSync } from 'node:fs';",
      "import { setTimeout as sleep } from 'node:timers/promises';",
      "appendFileSync('spawned.log', process.argv.slice(2).join(' ') + '\\n');",
      "while (!existsSync('release')) await sleep(20);",
    ].join('\n'));
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });
  const start = async (approveToolAction?: (action: ToolActionApproval) => Promise<boolean>, childEnv: () => NodeJS.ProcessEnv = () => process.env) => {
    server = await startUiServer({ home, root: dir, port: 0, cliPath: join(dir, 'cli.mjs'), childEnv, approveToolAction });
  };
  const call = async (path: string, method = 'GET', data?: unknown): Promise<Response> => {
    const tool = path.startsWith('/tools/');
    return fetch(server!.url + path.slice(1), {
      method,
      headers: { ...(tool ? { authorization: `Bearer ${server!.toolToken}` } : { cookie: `d365fo_ui=${server!.token}`, 'x-requested-with': 'd365fo-ui' }), 'content-type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  };
  const wait = async (predicate: (state: any) => boolean): Promise<any> => {
    for (let i = 0; i < 200; i++) {
      const state = await (await call('/api/run')).json();
      if (predicate(state)) return state;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('The job did not reach the expected state');
  };

  it('accepts exactly one simultaneous run/upload/rerun across the UI and tools', async () => {
    await start(async () => true);
    const requests = [
      ['/api/run', { ...body, dryRun: true }], ['/tools/runs', { ...body, dryRun: true }],
      [`/api/history/${savedId}/upload`, {}], [`/tools/history/${savedId}/upload`, {}],
      [`/api/history/${savedId}/rerun`, { dryRun: true }], [`/tools/history/${savedId}/rerun`, { dryRun: true }],
      ['/api/run', body], ['/tools/runs', body],
    ] as const;
    const replies = await Promise.all(requests.map(([path, data]) => call(path, 'POST', data)));
    assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409, 409, 409]);
    await writeFile(join(dir, 'release'), '');
    await wait((s) => s?.settled);
    assert.equal((await readFile(join(dir, 'spawned.log'), 'utf8')).trim().split('\n').length, 1);
  });

  it('shows and stops a pending start before it can create a child, then releases the slot', async () => {
    await start();
    const entered = deferred(); const release = deferred();
    const original = ProfileStore.prototype.idOf;
    ProfileStore.prototype.idOf = async function (name: string) {
      if (this.home === home) { entered.resolve(); await release.promise; }
      return original.call(this, name);
    };
    try {
      const request = call('/api/run', 'POST', body);
      await entered.promise;
      const pending = await (await call('/api/run')).json() as any;
      assert.deepEqual([pending.status, pending.phase, pending.settled], ['running', 'starting', false]);
      assert.equal((await call('/api/run', 'POST', body)).status, 409);
      assert.equal((await call('/api/active', 'POST', { name: 'Beta' })).status, 409);
      assert.equal(((await (await call('/api/run/stop', 'POST', {})).json()) as any).stopped, true);
      release.resolve();
      assert.equal((await request).status, 400);
      await wait((s) => s?.status === 'stopped' && s.settled);
      await assert.rejects(readFile(join(dir, 'spawned.log')), { code: 'ENOENT' });
    } finally { release.resolve(); ProfileStore.prototype.idOf = original; }
    await writeFile(join(dir, 'release'), '');
    assert.equal((await call('/api/run', 'POST', body)).status, 200);
    await wait((s) => s?.settled);
  });

  it('keeps the slot and running status until history has finished settling', async () => {
    await start();
    await writeFile(join(dir, 'release'), '');
    const entered = deferred(); const release = deferred();
    const original = RunHistory.prototype.record;
    RunHistory.prototype.record = async function (...args: Parameters<RunHistory['record']>) {
      if (await this.historyDir() === join(reportDir, 'history')) { entered.resolve(); await release.promise; }
      return original.apply(this, args);
    };
    try {
      assert.equal((await call('/api/run', 'POST', body)).status, 200);
      await entered.promise;
      const pending = await (await call('/api/run')).json() as any;
      assert.deepEqual([pending.status, pending.phase, pending.settled], ['running', 'finalizing', false]);
      assert.equal((await call('/api/run', 'POST', body)).status, 409);
      assert.equal((await call(`/api/history/${savedId}/upload`, 'POST', {})).status, 409);
      assert.equal((await call('/api/active', 'POST', { name: 'Beta' })).status, 409);
      let finished = false;
      const following = call('/tools/runs/current?waitSeconds=30').then((r) => { finished = true; return r; });
      await new Promise((done) => setTimeout(done, 20));
      assert.equal(finished, false);
      release.resolve();
      assert.equal(((await (await following).json()) as any).run.status, 'passed');
      await wait((s) => s?.settled);
    } finally { release.resolve(); RunHistory.prototype.record = original; }
  });

  it('releases a reservation after setup fails', async () => {
    let broken = true;
    await start(undefined, () => { if (broken) throw new Error('Simulated settings failure'); return process.env; });
    assert.equal((await call('/api/run', 'POST', body)).status, 500);
    await wait((s) => s?.status === 'failed' && s.settled);
    broken = false;
    await writeFile(join(dir, 'release'), '');
    assert.equal((await call('/api/run', 'POST', body)).status, 200);
    await wait((s) => s?.settled);
  });

  it('denies model-supplied confirmations without a native approver, while diagnostics remain available', async () => {
    await start();
    const forged = { ...body, confirmed: true, approval: 'user confirmed', userConfirmation: true };
    assert.equal((await call('/tools/runs', 'POST', forged)).status, 403);
    assert.equal((await call(`/tools/history/${savedId}/rerun`, 'POST', { confirmed: true })).status, 403);
    assert.equal((await call(`/tools/history/${savedId}/upload`, 'POST', { confirmed: true, plan: '7' })).status, 403);
    await assert.rejects(readFile(join(dir, 'spawned.log')), { code: 'ENOENT' });
    await writeFile(join(dir, 'release'), '');
    assert.equal((await call('/tools/runs', 'POST', { ...body, dryRun: true })).status, 200);
    await wait((s) => s?.settled);
  });

  it('binds native approval to the actual profile, source and selected cases', async () => {
    const entered = deferred(); const release = deferred();
    let shown: ToolActionApproval | undefined;
    await start(async (action) => { shown = action; entered.resolve(); await release.promise; return true; });
    const request = call('/tools/runs', 'POST', { ...body, profile: 'Beta', confirmed: true });
    try {
      await entered.promise;
      assert.deepEqual(shown, {
        kind: 'run', profile: 'Alpha', environment: { url: 'https://alpha.sandbox.operations.dynamics.com', company: 'GBSI' },
        source: { type: 'local', folder: join(dir, 'cases') }, cases: ['TC-1', 'TC-2'],
      });
      assert.equal((await call('/tools/profiles/active', 'POST', { name: 'Beta' })).status, 409);
      assert.equal((await call('/api/profiles/Alpha', 'PUT', { entries: [] })).status, 409);
      assert.equal((await call('/api/ai', 'PUT', { entries: [] })).status, 409);
      await new TestCaseFiles(dir).save('cases', { id: 'TC-3', title: 'Added after approval', steps: [{ action: 'New action' }] });
      release.resolve();
      assert.equal((await request).status, 200);
      await writeFile(join(dir, 'release'), '');
      await wait((s) => s?.settled);
      const args = await readFile(join(dir, 'spawned.log'), 'utf8');
      assert.match(args, /--case TC-1,TC-2/);
      assert.doesNotMatch(args, /TC-3/);
    } finally { release.resolve(); }
  });
});
