import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

describe('test-case editor, run history and upload', () => {
  // Fake CLI: `run` writes a results.json like the real one, `upload` prints the line the real one prints.
  const FAKE_CLI = [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'run') {",
    "  mkdirSync('reports', { recursive: true });",
    "  writeFileSync('reports/results.json', JSON.stringify([{ testCaseId: 'TC-1', title: 'One', outcome: 'passed', steps: [], durationMs: 5 }, { testCaseId: 'TC-2', title: 'Two', outcome: 'failed', steps: [], durationMs: 5 }]));",
    "  writeFileSync('reports/report.html', '<html>report</html>');",
    "  process.exitCode = 1;",
    "} else if (args[0] === 'upload') {",
    "  console.log('INPUT ' + args[2] + ' PLAN ' + (args[4] ?? '-'));",
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
});

describe('Open WebUI tool server', () => {
  const FAKE_CLI = [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'run') {",
    "  mkdirSync('reports', { recursive: true });",
    "  writeFileSync('reports/results.json', JSON.stringify([{ testCaseId: 'TC-1', title: 'One', outcome: 'passed', steps: [], durationMs: 5 }, { testCaseId: 'TC-2', title: 'Two', outcome: 'failed', steps: [{ index: 2, status: 'failed', errorMessage: 'Save button missing', durationMs: 1 }], durationMs: 5 }]));",
    "  console.log('ran ' + args.join(' '));",
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
    tui = await startUiServer({ home: join(dir, 'home'), port: 0, cliPath: join(dir, 'cli.mjs'), root: dir });
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

  it('publishes an OpenAPI document without a key, with CORS for browser-side tool servers', async () => {
    const r = await tcall('/openapi.json', { key: null });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const spec = (await r.json()) as any;
    const docker = await raw('/tools/openapi.json', { host: `host.docker.internal:${tui.port}` });
    assert.equal(JSON.parse(docker.body).servers[0].url, `http://host.docker.internal:${tui.port}/tools`, 'server URL follows the address Open WebUI used');
    const viaDocker = await raw('/tools/profiles', { host: `host.docker.internal:${tui.port}`, authorization: `Bearer ${tui.toolToken}` });
    assert.equal(viaDocker.status, 200);
    const ops = Object.values(spec.paths).flatMap((p: any) => Object.values(p).map((o: any) => o.operationId));
    assert.deepEqual(ops.sort(), ['check_setup', 'get_results', 'get_run', 'list_learned_pages', 'list_profiles', 'list_runs', 'list_test_cases', 'read_test_case', 'save_test_case', 'start_run', 'stop_run', 'upload_run', 'use_profile']);
    const pre = await fetch(`http://127.0.0.1:${tui.port}/tools/runs`, { method: 'OPTIONS', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.match(String(pre.headers.get('access-control-allow-headers')), /Authorization/);
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
    await new ProfileStore(home).write('UAT', [{ key: 'D365_PASSWORD', value: 'hunter2!' }], 'create');
    assert.equal((await tcall('/profiles/active', { method: 'POST', body: JSON.stringify({ name: 'Nope' }) })).status, 404);
    assert.equal((await tcall('/profiles/active', { method: 'POST', body: JSON.stringify({ name: 'UAT' }) })).status, 200);
    const r = await tcall('/profiles');
    const text = await r.text();
    assert.ok(!text.includes('hunter2'));
    assert.equal(JSON.parse(text).active, 'UAT');
  });

  it('lists the F&O forms learned during runs, and checks the profile in use', async () => {
    await mkdir(join(dir, 'knowledge'), { recursive: true });
    const learned = { version: 1, pages: [{ key: 'mi:vendtablelistpage', mi: 'VendTableListPage', caption: 'All vendors', visits: 3, controls: [{ name: 'New', target: "getByTestId('SystemDefinedNewButton')", action: 'click', uses: 2, failures: 0, lastUsed: '' }], notes: ['n'], updatedAt: '' }] };
    await writeFile(join(dir, 'knowledge', 'pages.json'), JSON.stringify(learned));
    const pages = ((await (await tcall('/knowledge/pages?search=vend')).json()) as any).pages;
    assert.deepEqual(pages, [{ caption: 'All vendors', menuItem: 'VendTableListPage', visits: 3, controls: 1, notes: ['n'], updatedAt: '' }]);
    assert.deepEqual(((await (await tcall('/knowledge/pages?search=sales')).json()) as any).pages, []);
    const check = (await (await tcall('/setup/check', { method: 'POST' })).json()) as any;
    assert.equal(check.profile, 'UAT');
    assert.equal(typeof check.output, 'string');
  });

  it('saves, lists and reads test cases', async () => {
    const tc = { title: 'Post invoice', steps: [{ action: 'Open invoice journal', expected: 'Journal list shown' }] };
    const saved = await tcall('/testcases?dir=cases', { method: 'PUT', body: JSON.stringify({ testCase: tc }) });
    assert.equal(saved.status, 200);
    const { file } = (await saved.json()) as any;
    assert.deepEqual(((await (await tcall('/testcases?dir=cases')).json()) as any[]).map((c) => c.title), ['Post invoice']);
    assert.equal(((await (await tcall(`/testcases/file?dir=cases&file=${file}`)).json()) as any).steps.length, 1);
    assert.equal((await tcall('/testcases?dir=../..')).status, 400);
  });

  it('starts a run, waits for it, summarises results and uploads it from the history', async () => {
    assert.equal(((await (await tcall('/results')).json()) as any).error !== undefined, true);
    assert.equal((await tcall('/runs', { method: 'POST', body: JSON.stringify({ source: 'devops', plan: '1;x' }) })).status, 400);
    assert.equal((await tcall('/runs', { method: 'POST', body: JSON.stringify({ source: 'local', local: 'cases', dryRun: true }) })).status, 200);
    let run: any;
    for (let i = 0; i < 20 && !(run && run.status !== 'running'); i++) run = ((await (await tcall('/runs/current?waitSeconds=5&tail=5')).json()) as any).run;
    assert.equal(run.status, 'passed');
    assert.ok(run.log.some((l: string) => /ran run --local cases --dry-run/.test(l)));
    const results = (await (await tcall('/results')).json()) as any;
    assert.deepEqual(results.totals, { total: 2, passed: 1, failed: 1, blocked: 0, skipped: 0 });
    assert.deepEqual([results.cases[1].reason, results.cases[1].failedStep], ['Save button missing', 2]);

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
