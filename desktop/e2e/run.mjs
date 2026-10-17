#!/usr/bin/env node
// End-to-end check of an installed desktop app: starts it with Chromium's remote debugging port, attaches with the
// Playwright bundled inside the app, and drives the settings app and Open WebUI the way a user would. Profiles and the
// workspace go to fresh folders under E2E_OUT, so the computer's own profiles are never touched.
//
//   E2E_APP          path of the installed "D365FO Agent.exe" (required)
//   E2E_OUT          folder for screenshots, logs and summary.md (required)
//   E2E_APP_ARGS     extra command-line switches for the app (optional)
//   E2E_OPENWEBUI    'false' to skip waiting for Open WebUI (default: wait)
//   E2E_OPENWEBUI_MINUTES  how long to wait for Open WebUI, including a first-start install (default 25)
//   E2E_ANTHROPIC_API_KEY, E2E_D365_BASE_URL, E2E_D365_USERNAME, E2E_D365_PASSWORD (optional, all four): also run the
//                    sample login test case in dry-run mode against that F&O environment. E2E_D365_COMPANY is optional.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

const exe = process.env.E2E_APP;
const out = process.env.E2E_OUT;
if (!exe || !out) {
  console.error('Set E2E_APP (the installed app) and E2E_OUT (an output folder).');
  process.exit(1);
}
const waitOpenWebUi = process.env.E2E_OPENWEBUI !== 'false';
const owuiMinutes = Number(process.env.E2E_OPENWEBUI_MINUTES || 25);
const creds = ['E2E_ANTHROPIC_API_KEY', 'E2E_D365_BASE_URL', 'E2E_D365_USERNAME', 'E2E_D365_PASSWORD'].every((k) => process.env[k]);

const home = join(out, 'agent-home');
const workspace = join(out, 'workspace');
const shots = join(out, 'screenshots');
for (const d of [home, workspace]) rmSync(d, { recursive: true, force: true });
for (const d of [home, workspace, shots]) mkdirSync(d, { recursive: true });

const results = [];
let failed = false;
async function check(name, fn, { required = true } = {}) {
  const started = Date.now();
  try {
    const detail = (await fn()) ?? '';
    results.push({ name, ok: true, detail, secs: (Date.now() - started) / 1000 });
    console.log(`PASS ${name}${detail ? `: ${detail}` : ''}`);
    return true;
  } catch (e) {
    if (required) failed = true;
    results.push({ name, ok: false, required, detail: e?.message ?? String(e), secs: (Date.now() - started) / 1000 });
    console.log(`${required ? 'FAIL' : 'WARN'} ${name}: ${e?.message ?? e}`);
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, ms, fn, every = 1000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`Timed out after ${Math.round(ms / 1000)} s waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// The Playwright the app ships for its own test runs (asar is off, so it is a plain folder next to the exe).
const appRequire = createRequire(join(dirname(exe), 'resources', 'app', 'package.json'));
const { chromium } = appRequire('playwright-core');

const cdpPort = await freePort();
const log = createWriteStream(join(out, 'app.log'));
// --disable-gpu: build VMs often have no usable GPU. E2E_APP_ARGS adds switches, e.g. --no-sandbox when run as root on Linux.
const extraArgs = (process.env.E2E_APP_ARGS ?? '').split(' ').filter(Boolean);
const child = spawn(exe, [`--remote-debugging-port=${cdpPort}`, '--disable-gpu', ...extraArgs], {
  env: { ...process.env, D365FO_AGENT_HOME: home, D365FO_WORKSPACE: workspace, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
});
child.stdout.pipe(log);
child.stderr.pipe(log);
let exited;
child.on('exit', (code) => (exited = code));
child.on('error', (e) => (exited = `not started: ${e.message}`));

function stopApp() {
  if (exited !== undefined || !child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

let browser;
const allPages = () => browser.contexts().flatMap((c) => c.pages());
const findPage = (what, ms, test) =>
  until(what, ms, async () => {
    if (exited !== undefined) throw new Error(`the app exited with code ${exited}`);
    for (const p of allPages()) if (await test(p).catch(() => false)) return p;
    return undefined;
  });
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) }).catch((e) => console.log(`(screenshot ${name} failed: ${e.message})`));

/** Calls the settings app's API from inside its own page, so the session cookie and origin checks apply as for a user. */
const api = (page, path, method = 'GET', body) =>
  page.evaluate(
    async ([path, method, body]) => {
      const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'd365fo-ui' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: r.status, body: json };
    },
    [path, method, body],
  );
function expectStatus(res, ...ok) {
  if (!ok.includes(res.status)) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body;
}

let settings;
let rail;
try {
  await check('App starts and exposes its windows', async () => {
    await until('the remote debugging port', 90_000, async () => {
      if (exited !== undefined) throw new Error(`the app exited with code ${exited}`);
      return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok;
    });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    rail = await findPage('the side strip', 60_000, async (p) => p.url().endsWith('rail.html'));
    await shot(rail, '01-rail');
    return `${allPages().length} views`;
  });

  await check('Settings app loads', async () => {
    settings = await findPage('the settings app', 120_000, async (p) => /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url()) && (await p.evaluate(() => typeof showTab === 'function')));
    const state = expectStatus(await api(settings, '/api/state'), 200);
    if (state.home !== home) throw new Error(`settings app uses ${state.home}, expected ${home}`);
    return settings.url().replace(/\?.*/, '');
  });

  if (settings) {
    await check('Sample test cases are copied to the workspace', async () => {
      const cases = expectStatus(await api(settings, '/api/cases?local=examples/testcases'), 200);
      if (!Array.isArray(cases) || cases.length < 1) throw new Error(`no cases listed: ${JSON.stringify(cases)}`);
      return `${cases.length} cases (${cases.map((c) => c.id).join(', ')})`;
    });

    if (creds) {
      await check('Shared AI connection works', async () => {
        expectStatus(await api(settings, '/api/ai', 'PUT', { entries: [{ key: 'ANTHROPIC_API_KEY', value: process.env.E2E_ANTHROPIC_API_KEY }] }), 200);
        const result = expectStatus(await api(settings, '/api/ai/check', 'POST'), 200);
        if (!result.ok) throw new Error(result.detail || 'The model connection failed.');
        return result.detail;
      });
    }

    await check('Profile can be created and selected', async () => {
      const entries = [
        { key: 'D365_BASE_URL', value: process.env.E2E_D365_BASE_URL || 'https://e2e-placeholder.sandbox.operations.dynamics.com' },
        ...(creds
          ? [
              { key: 'D365_USERNAME', value: process.env.E2E_D365_USERNAME },
              { key: 'D365_PASSWORD', value: process.env.E2E_D365_PASSWORD },
              ...(process.env.E2E_D365_COMPANY ? [{ key: 'D365_COMPANY', value: process.env.E2E_D365_COMPANY }] : []),
            ]
          : []),
      ];
      expectStatus(await api(settings, '/api/profiles', 'POST', { name: 'e2e', entries }), 201);
      const active = expectStatus(await api(settings, '/api/active', 'POST', { name: 'e2e' }), 200).active;
      if (active !== 'e2e') throw new Error(`active profile is ${active}`);
      // The calls above bypass the page's own form, so let it re-read the state as it does after a save.
      await settings.evaluate(() => refresh());
    });

    await check('Settings save through the form and survive a reload', async () => {
      await rail.click('button[data-id="settings"]');
      await settings.selectOption('#profilePicker', 'e2e');
      await settings.locator('#f_D365_COMPANY').fill(process.env.E2E_D365_COMPANY || 'USMF');
      if (await settings.locator('#saveProfile').isEnabled()) {
        await settings.click('#saveProfile');
        await settings.waitForFunction(() => document.querySelector('#profileStatus').textContent === 'Saved');
      }
      await settings.reload();
      await settings.evaluate(() => showTab('settings'));
      await settings.waitForFunction((value) => document.querySelector('#f_D365_COMPANY')?.value === value, process.env.E2E_D365_COMPANY || 'USMF');
    });

    await check("The agent's own CLI runs on the app's Electron (profile check)", async () => {
      const res = expectStatus(await api(settings, '/api/profiles/e2e/check', 'POST'), 200);
      writeFileSync(join(out, 'doctor.txt'), res.output ?? '');
      if (!/Settings profile: e2e/.test(res.output ?? '')) throw new Error(`unexpected output: ${(res.output ?? '').slice(0, 400)}`);
      if (creds && res.exitCode !== 0) throw new Error('Setup check failed; see doctor.txt.');
      return `exit code ${res.exitCode}${creds ? '' : ' (expected to list missing settings without credentials)'}`;
    });

    await check('Every page opens from the side strip', async () => {
      const tabs = ['cases', 'results', 'settings'];
      for (const [i, tab] of tabs.entries()) {
        await rail.click(`button[data-id="${tab}"]`);
        await until(`the ${tab} page`, 10_000, async () => (await rail.getAttribute(`button[data-id="${tab}"]`, 'aria-current')) === 'page');
        await sleep(500);
        await shot(settings, `${String(i + 2).padStart(2, '0')}-${tab}`);
      }
      const name = await until('the strip to show the e2e profile', 10_000, async () => ((await rail.textContent('#pname'))?.trim() === 'e2e' ? 'e2e' : undefined));
      return `${tabs.join(', ')}; strip shows profile ${name}`;
    });

    if (creds) {
      await check('Diagnostic sample run produces structured results (business outcome not validated)', async () => {
        expectStatus(await api(settings, '/api/run', 'POST', { source: 'local', local: 'examples/testcases', cases: ['TC-SMOKE-LOGIN'], dryRun: true }), 200);
        const run = await until('the test run to finish', 20 * 60_000, async () => {
          const r = expectStatus(await api(settings, '/api/run'), 200);
          return r && r.status !== 'running' ? r : undefined;
        }, 5000);
        writeFileSync(join(out, 'run.log'), (run.lines ?? []).join('\n'));
        await rail.click('button[data-id="results"]');
        await sleep(1000);
        await shot(settings, '10-results-after-run');
        const results = expectStatus(await api(settings, '/api/results'), 200);
        if (!Array.isArray(results) || results.length !== 1 || results[0].testCaseId !== 'TC-SMOKE-LOGIN') throw new Error('The expected case produced no current structured result.');
        if (!['passed', 'failed', 'blocked', 'skipped'].includes(results[0].outcome)) throw new Error('Unknown outcome.');
        return `diagnostic outcome ${results[0].outcome}; no live business pass claimed`;
      });
    }
  }

  if (waitOpenWebUi && browser) {
    await check(
      'Open WebUI installs and starts in the Chat page',
      async () => {
        let lastStatus = '';
        const chat = await findPage('Open WebUI', owuiMinutes * 60_000, async (p) => {
          if (p.url().endsWith('splash.html')) {
            const text = await p.evaluate(() => document.body.innerText.trim().split('\n').slice(-2).join(' | '));
            if (text && text !== lastStatus) console.log(`  splash: ${(lastStatus = text).slice(0, 200)}`);
            return false;
          }
          if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(p.url()) || p === settings) return false;
          return p.evaluate(async () => (await fetch('/health')).ok);
        });
        await rail.click('button[data-id="chat"]');
        await chat.waitForLoadState('load');
        await sleep(3000);
        await shot(chat, '20-openwebui');
        return chat.url();
      },
    );
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  stopApp();
  log.end();
}

const lines = [
  `## Desktop e2e (${process.platform}-${process.arch})`,
  '',
  '| Check | Result | Time | Detail |',
  '| --- | --- | --- | --- |',
  ...results.map((r) => `| ${r.name} | ${r.ok ? 'pass' : r.required === false ? 'warn' : '**fail**'} | ${r.secs.toFixed(0)} s | ${String(r.detail).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 300)} |`),
  '',
  creds ? 'F&O credentials were set; the sample diagnostic ran with mutations skipped. This does not establish that sign-in or the business workflow works.' : 'No F&O credentials set, so no test case was run against F&O.',
];
writeFileSync(join(out, 'summary.md'), `${lines.join('\n')}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
process.exit(failed || !results.length ? 1 : 0);
