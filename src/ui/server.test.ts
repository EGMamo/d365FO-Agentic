import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { parseEnvText } from './env-file.js';
import { startUiServer } from './server.js';

// Stands in for the real CLI: prints its arguments and what it would read from .env.
const FAKE_CLI = `
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
console.log('ARGS ' + args.join(' '));
console.log('ENV_COMPANY ' + (process.env.D365_COMPANY ?? 'from-file') + ' PROBE ' + process.env.D365_TEST_PROBE);
if (args.includes('--case') && args[args.indexOf('--case') + 1] === 'slow') setTimeout(() => {}, 60000);
else process.exitCode = args.includes('--dry-run') ? 0 : 3;
`;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'd365ui-'));
  await writeFile(join(dir, '.env'), "# comment\nLLM_PROVIDER=openai\nOPENAI_API_KEY=sk-secret-value\nD365_PASSWORD='M654#@!m'\nD365_COMPANY=USMF\n");
  await writeFile(join(dir, 'cli.mjs'), FAKE_CLI);
  const ui = await startUiServer({ port: 0, envPath: join(dir, '.env'), cliPath: join(dir, 'cli.mjs'), cwd: dir, token: 'tok', env: { PATH: process.env.PATH, D365_COMPANY: 'USMF', D365_TEST_PROBE: 'shell' } });
  const base = new URL(ui.url).origin;
  const call = async (path: string, init: RequestInit = {}, auth = true) =>
    fetch(base + path, { ...init, redirect: 'manual', headers: { ...(auth ? { cookie: 'd365fo_ui=tok' } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers as object) } });
  return { dir, ui, base, call, done: async () => { await ui.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('requires the token, rejects foreign hosts and non-JSON writes', async () => {
  const s = await setup();
  try {
    assert.equal((await s.call('/api/settings', {}, false)).status, 401);
    const login = await s.call('/?token=tok', {}, false);
    assert.equal(login.status, 303);
    assert.match(login.headers.get('set-cookie') ?? '', /d365fo_ui=tok; HttpOnly; SameSite=Strict/);
    assert.equal((await s.call('/?token=nope', {}, false)).status, 403);
    assert.equal((await s.call('/api/run/stop', { method: 'POST' })).status, 415);
    assert.equal((await s.call('/api/run/stop', { method: 'POST', body: '{}', headers: { origin: 'http://evil.test' } })).status, 403);
    const port = new URL(s.base).port;
    const status = await new Promise<number>((done) => {
      request({ host: '127.0.0.1', port, path: '/api/settings', headers: { host: `evil.test:${port}`, cookie: 'd365fo_ui=tok' } }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      }).end();
    });
    assert.equal(status, 403);
  } finally {
    await s.done();
  }
});

test('settings never expose secrets and saves keep comments, quote values and tighten permissions', async () => {
  const s = await setup();
  try {
    const got = (await (await s.call("/api/settings")).json()) as any;
    assert.ok(!JSON.stringify(got).includes('sk-secret-value'));
    assert.ok(!JSON.stringify(got).includes('M654'));
    const pw = got.fields.find((f: { key: string }) => f.key === 'D365_PASSWORD');
    assert.deepEqual([pw.value, pw.set], ['', true]);
    assert.equal(got.fields.find((f: { key: string }) => f.key === 'D365_COMPANY').value, 'USMF');

    const bad = await s.call('/api/settings', { method: 'PUT', body: JSON.stringify({ values: { LLM_PROVIDER: 'nope' } }) });
    assert.equal(bad.status, 400);

    const ok = await s.call('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ values: { D365_COMPANY: 'DAT', D365_PASSWORD: '', OPENAI_API_KEY: 'new#key', NOT_A_SETTING: 'x' }, clear: ['D365_BASE_URL'] }),
    });
    assert.equal(ok.status, 200);
    // A blank secret box keeps the stored secret; only an explicit clear removes a value.
    assert.deepEqual(parseEnvText(await readFile(join(s.dir, '.env'), 'utf8')), {
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'new#key',
      D365_PASSWORD: 'M654#@!m',
      D365_COMPANY: 'DAT',
      D365_BASE_URL: '',
    });
    if (process.platform !== 'win32') assert.equal((await stat(join(s.dir, '.env'))).mode & 0o777, 0o600);
  } finally {
    await s.done();
  }
});

test('runs start the CLI with the chosen options, stream the log, and can be stopped', async () => {
  const s = await setup();
  try {
    const events = await s.call('/api/run/events');
    const reader = events.body!.getReader();
    let seen = '';
    const readUntil = async (needle: string) => {
      while (!seen.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${needle}`);
        seen += new TextDecoder().decode(value);
      }
    };

    const start = await s.call('/api/run', { method: 'POST', body: JSON.stringify({ source: 'local', local: 'cases', caseId: 'TC-1', dryRun: true, retries: 2 }) });
    assert.equal(start.status, 200);
    await readUntil('"status":"passed"');
    assert.match(seen, /ARGS run --local cases --case TC-1 --dry-run --reloop-max-retries 2/);
    // The child reads .env itself; a stale copy from when the UI started must not be passed down.
    assert.match(seen, /ENV_COMPANY from-file PROBE shell/);

    assert.equal((await s.call('/api/run', { method: 'POST', body: JSON.stringify({ source: 'devops', plan: '1; rm -rf /' }) })).status, 400);

    await s.call('/api/run', { method: 'POST', body: JSON.stringify({ source: 'devops', plan: '8', suite: '9', caseId: 'slow' }) });
    assert.equal((await s.call('/api/run', { method: 'POST', body: JSON.stringify({ source: 'local', local: 'x' }) })).status, 409);
    await readUntil('ARGS run --plan 8 --suite 9 --case slow');
    await s.call('/api/run/stop', { method: 'POST', body: '{}' });
    await readUntil('"status":"stopped"');
    const last = (await (await s.call("/api/run")).json()) as any;
    assert.equal(last.status, 'stopped');
    assert.ok(last.lines.some((l: string) => l.includes('ARGS run --plan 8 --suite 9 --case slow')));
    await reader.cancel();
  } finally {
    await s.done();
  }
});
