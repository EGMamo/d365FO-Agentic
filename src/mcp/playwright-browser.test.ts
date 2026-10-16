import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  checkPlaywrightBrowser,
  ensurePlaywrightBrowser,
  playwrightCacheDir,
  playwrightInstallArgs,
  PLAYWRIGHT_MCP_PACKAGE,
  type Exec,
} from './playwright-browser.js';
import { buildDefaultManager } from './registry.js';
import { loadConfig } from '../config/index.js';

const cfg = (over: Partial<{ PW_AUTO_INSTALL: boolean; PW_BROWSER: 'chromium' | 'firefox' | 'webkit' }> = {}) => ({
  PW_AUTO_INSTALL: true,
  PW_BROWSER: 'chromium' as const,
  ...over,
});

let logs: string[];
beforeEach(() => {
  logs = [];
  mock.method(console, 'log', (...a: unknown[]) => void logs.push(a.join(' ')));
});
afterEach(() => mock.restoreAll());

describe('playwrightInstallArgs', () => {
  it('maps PW_BROWSER to the installer names, pinning the same package the server launches with', () => {
    assert.deepEqual(playwrightInstallArgs('chromium'), [
      '-y',
      PLAYWRIGHT_MCP_PACKAGE,
      'install-browser',
      '--no-progress',
      '--no-remove',
      'chrome-for-testing',
    ]);
    assert.equal(playwrightInstallArgs('firefox').at(-1), 'firefox');
    assert.equal(playwrightInstallArgs('webkit').at(-1), 'webkit');
  });

  it('uses the same package spec as the Playwright MCP server launch', () => {
    // `specs` is private; reading it here pins the launch and the install to one Playwright version.
    const { specs } = buildDefaultManager(loadConfig()) as unknown as {
      specs: Map<string, { args?: string[] }>;
    };
    assert.ok(specs.get('playwright')?.args?.includes(PLAYWRIGHT_MCP_PACKAGE));
  });
});

describe('checkPlaywrightBrowser (used by doctor)', () => {
  const probe = (entries: string[] | Error) => ({
    env: {} as NodeJS.ProcessEnv,
    platform: 'linux' as const,
    home: '/home/u',
    list: async () => {
      if (entries instanceof Error) throw entries;
      return entries;
    },
  });

  it('reports a missing browser with the exact install command', async () => {
    const status = await checkPlaywrightBrowser({ PW_BROWSER: 'chromium' }, probe(['firefox-1495', 'chromium_headless_shell-1247']));
    assert.equal(status.installed, false);
    // join: the path uses this computer's separator, so the tests pass on Windows too.
    assert.equal(status.cacheDir, join('/home/u', '.cache', 'ms-playwright'));
    assert.equal(
      status.installCommand,
      `npx -y ${PLAYWRIGHT_MCP_PACKAGE} install-browser --no-progress --no-remove chrome-for-testing`,
    );
  });

  it('treats a missing cache directory as not installed', async () => {
    const status = await checkPlaywrightBrowser({ PW_BROWSER: 'firefox' }, probe(new Error('ENOENT')));
    assert.equal(status.installed, false);
    assert.match(status.installCommand, /firefox$/);
  });

  it('detects the configured browser in the cache', async () => {
    assert.equal((await checkPlaywrightBrowser({ PW_BROWSER: 'chromium' }, probe(['chromium-1247']))).installed, true);
    assert.equal((await checkPlaywrightBrowser({ PW_BROWSER: 'webkit' }, probe(['chromium-1247']))).installed, false);
  });

  it('does not guess when browsers live in node_modules (PLAYWRIGHT_BROWSERS_PATH=0)', async () => {
    const status = await checkPlaywrightBrowser(
      { PW_BROWSER: 'chromium' },
      { ...probe([]), env: { PLAYWRIGHT_BROWSERS_PATH: '0' } },
    );
    assert.equal(status.installed, undefined);
  });

  it('resolves the cache directory per platform and honours the override', () => {
    assert.equal(playwrightCacheDir({ PLAYWRIGHT_BROWSERS_PATH: '/pw' }, 'linux', '/h'), '/pw');
    assert.equal(playwrightCacheDir({}, 'darwin', '/Users/u'), join('/Users/u', 'Library', 'Caches', 'ms-playwright'));
    assert.equal(playwrightCacheDir({ LOCALAPPDATA: '/L' }, 'win32', '/h'), join('/L', 'ms-playwright'));
  });
});

describe('ensurePlaywrightBrowser', () => {
  it('does nothing when auto-install is disabled', async () => {
    const exec: Exec = async () => assert.fail('installer must not run');
    await ensurePlaywrightBrowser(cfg({ PW_AUTO_INSTALL: false }), exec);
  });

  it('runs npx with the install args for the configured browser', async () => {
    let seen: { command: string; args: string[] } | undefined;
    const exec: Exec = async (command, args) => {
      seen = { command, args };
      return { code: 0, output: '' };
    };
    await ensurePlaywrightBrowser(cfg({ PW_BROWSER: 'firefox' }), exec);
    assert.deepEqual(seen, { command: 'npx', args: playwrightInstallArgs('firefox') });
  });

  it('stays silent when nothing needs downloading (hides the installer banner)', async () => {
    const exec: Exec = async (_c, _a, onLine) => {
      onLine('╔══ WARNING: running npx playwright install without dependencies ══╗');
      onLine('║     npm install                                                  ║');
      return { code: 0, output: '' };
    };
    await ensurePlaywrightBrowser(cfg(), exec);
    assert.deepEqual(logs, []);
  });

  it('reports downloads as they happen', async () => {
    const exec: Exec = async (_c, _a, onLine) => {
      onLine('Downloading Chrome for Testing 155.0 (playwright chromium v1247) from https://cdn.playwright.dev/x.zip');
      onLine('Chrome for Testing 155.0 (playwright chromium v1247) downloaded to /cache/chromium-1247');
      return { code: 0, output: '' };
    };
    await ensurePlaywrightBrowser(cfg(), exec);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /^\[agent\] Downloading Chrome for Testing/);
    assert.match(logs[1], /downloaded to \/cache\/chromium-1247/);
  });

  it('fails with the installer output and a way out when the install fails', async () => {
    const output = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\nFailed to download Chrome';
    const exec: Exec = async () => ({ code: 1, output });
    await assert.rejects(ensurePlaywrightBrowser(cfg(), exec), (e: Error) => {
      assert.match(e.message, /exited with code 1/);
      assert.match(e.message, /Failed to download Chrome/);
      assert.ok(!e.message.includes('line 0\n'), 'only the tail of the output is included');
      assert.ok(e.message.includes(`npx -y ${PLAYWRIGHT_MCP_PACKAGE} install-browser`));
      assert.match(e.message, /chrome-for-testing/);
      assert.match(e.message, /PW_AUTO_INSTALL=false/);
      return true;
    });
  });

  it('says so when the installer is killed by the timeout', async () => {
    const exec: Exec = async () => ({ code: null, output: 'partial' });
    await assert.rejects(ensurePlaywrightBrowser(cfg(), exec), /timing out/);
  });

  it('explains how to proceed when the installer cannot even start', async () => {
    const exec: Exec = async () => {
      throw new Error('spawn npx ENOENT');
    };
    await assert.rejects(ensurePlaywrightBrowser(cfg(), exec), /Could not start.*ENOENT[\s\S]*PW_AUTO_INSTALL=false/);
  });
});

describe('default executor (real child process)', () => {
  it('spawns npx, streams cleaned lines, and reports the exit code (fake npx on PATH)', async (t) => {
    if (process.platform === 'win32') return t.skip('shell shim differs on Windows; stubbed tests cover the logic');

    const dir = await mkdtemp(join(tmpdir(), 'fake-npx-'));
    const script =
      '#!/bin/sh\n' +
      'printf "banner line\\n"\n' +
      'printf "\\033[2mDownloading Chrome for Testing 1 from https://x\\033[22m\\r"\n' + // ANSI + carriage return
      'printf "Thing downloaded to /cache/x\\n"\n' +
      'echo "args: $@" >&2\n' +
      'exit ${FAKE_NPX_EXIT:-0}\n';
    await writeFile(join(dir, 'npx'), script);
    await chmod(join(dir, 'npx'), 0o755);

    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    try {
      process.env.FAKE_NPX_EXIT = '0';
      await ensurePlaywrightBrowser(cfg());
      assert.deepEqual(logs, [
        '[agent] Downloading Chrome for Testing 1 from https://x',
        '[agent] Thing downloaded to /cache/x',
      ]);

      logs.length = 0;
      process.env.FAKE_NPX_EXIT = '7';
      await assert.rejects(ensurePlaywrightBrowser(cfg()), (e: Error) => e.message.includes('exited with code 7') && e.message.includes(`args: -y ${PLAYWRIGHT_MCP_PACKAGE} install-browser`));
    } finally {
      process.env.PATH = oldPath;
      delete process.env.FAKE_NPX_EXIT;
    }
  });

  it('reports a missing npx as a clear error', async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = '/nonexistent-dir';
    try {
      // On Windows npx runs through cmd, which starts and then exits with its own "not recognized" message.
      const expected = process.platform === 'win32' ? /exited with code 1[\s\S]*PW_AUTO_INSTALL=false/ : /Could not start the Playwright browser installer/;
      await assert.rejects(ensurePlaywrightBrowser(cfg()), expected);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
