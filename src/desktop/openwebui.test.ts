import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DISABLED_FEATURES, EXCLUDED_PACKAGES, INSTALL_VARIANT, install, isInstalled, layout, OPENWEBUI_VERSION, overridesFile, serveEnv, syncChatModel, syncToolServer, toolConnection } from './openwebui.js';

const auth = { header: `x-d365fo-desktop-${'a'.repeat(64)}`, secretKey: 'b'.repeat(64) };
const base = { dataDir: '/d', toolUrl: 'u', toolKey: 'k', origin: 'http://127.0.0.1:8080', auth };

describe('desktop Open WebUI', () => {
  it('installs the hash-locked Open WebUI with uv into a fresh runtime folder, and remembers the version', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'owui-'));
    const paths = { uv: '/bin/uv', dataRoot, platform: 'linux' as const };
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd?: string }> = [];
    await install(paths, () => {}, async (_cmd, args, env, _onLine, cwd) => {
      calls.push({ args, env, cwd });
      return 0;
    });
    assert.equal(calls[0].args[0], 'venv');
    assert.ok(calls[0].args.includes('--managed-python'));
    assert.deepEqual(calls[1].args.slice(0, 2), ['pip', 'install']);
    assert.ok(calls[1].args.includes('--require-hashes') && calls[1].args.includes('--no-deps'), 'only the locked, hashed packages');
    assert.equal(calls[1].args[calls[1].args.indexOf('-r') + 1], 'requirements.lock', 'a bare name: uv cannot read a path with a space');
    assert.equal(calls[1].cwd, join(dataRoot, 'openwebui'));
    assert.ok(readFileSync(join(dataRoot, 'openwebui', 'requirements.lock'), 'utf8').includes('open-webui==' + OPENWEBUI_VERSION));
    assert.equal(calls[1].env.UV_PYTHON_INSTALL_DIR, join(dataRoot, 'openwebui', 'python'));
    const marker = JSON.parse(readFileSync(join(dataRoot, 'openwebui', 'installed.json'), 'utf8'));
    assert.equal(marker.version, OPENWEBUI_VERSION);
    assert.equal(marker.variant, INSTALL_VARIANT);
    const l = layout(paths);
    assert.ok(l.venv.endsWith(marker.runtime), 'the new runtime becomes the active one');
    assert.equal(await isInstalled(paths), false, 'no executable yet');
    await mkdir(join(l.venv, 'bin'), { recursive: true });
    await writeFile(l.exe, '');
    assert.equal(await isInstalled(paths), true);
    assert.equal(await isInstalled(paths, '9.9.9'), false, 'a newer pin reinstalls');
    await writeFile(l.marker, JSON.stringify({ ...marker, variant: 'older' }));
    assert.equal(await isInstalled(paths), false, 'an install from an older variant is replaced');
  });

  it('leaves out the heavy packages and switches off unused features', () => {
    const lines = overridesFile().trim().split('\n');
    assert.equal(lines.length, EXCLUDED_PACKAGES.length);
    assert.ok(lines.every((l) => l.endsWith("; sys_platform == 'never'")));
    const env = serveEnv(base, { ANTHROPIC_API_KEY: 'private', D365_PASSWORD: 'private', HTTPS_PROXY: 'http://company-proxy' });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.D365_PASSWORD, undefined);
    assert.equal(env.HTTPS_PROXY, 'http://company-proxy');
    assert.equal(env.ENABLE_PERSISTENT_CONFIG, 'False');
    assert.equal(env.USE_SLIM_DOCKER, 'true');
    for (const f of DISABLED_FEATURES) assert.equal(env[f], 'False', f);
    assert.notEqual(env.ENABLE_OPENAI_API, 'False', 'the chat model connection stays on');
    assert.ok(!DISABLED_FEATURES.includes('ENABLE_OPENAI_API'));
  });

  it('stops with a clear message when uv fails', async () => {
    const paths = { uv: '/bin/uv', dataRoot: await mkdtemp(join(tmpdir(), 'owui-')) };
    await assert.rejects(install(paths, () => {}, async (_c, args) => (args[0] === 'pip' ? 1 : 0)), /Could not install Open WebUI/);
  });

  it('connects the tool server, locks sign-in to the desktop header and passes the chat model', () => {
    const env = serveEnv({ ...base, toolUrl: 'http://127.0.0.1:4365/tools', chat: { url: 'https://api.openai.com/v1', key: 'sk' } }, {});
    assert.equal(env.WEBUI_AUTH, 'True');
    assert.equal(env.WEBUI_AUTH_TRUSTED_EMAIL_HEADER, auth.header);
    assert.equal(env.ENABLE_LOGIN_FORM, 'False');
    assert.equal(env.ENABLE_SIGNUP, 'False');
    assert.equal(env.WEBUI_SECRET_KEY, auth.secretKey);
    assert.equal(env.DATA_DIR, '/d');
    const tools = JSON.parse(env.TOOL_SERVER_CONNECTIONS!);
    assert.equal(tools[0].url, 'http://127.0.0.1:4365/tools');
    assert.equal(tools[0].key, 'k');
    assert.equal(env.OPENAI_API_BASE_URL, 'https://api.openai.com/v1');
    assert.equal(serveEnv(base, { NO_PROXY: 'corp.local' }).NO_PROXY, 'corp.local,127.0.0.1,localhost');
    assert.equal(serveEnv(base, {}).OPENAI_API_KEY, undefined);
  });


});

describe('tool server sync', () => {
  const conn = toolConnection({ toolUrl: 'http://127.0.0.1:2/tools', toolKey: 'new' });
  const fake = (stored: unknown[]) => {
    const calls: Array<{ path: string; method: string; body?: any }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const method = init.method ?? 'GET';
      calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/api/v1/auths/signin') return Response.json({ token: 't0k' });
      assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer t0k');
      return Response.json({ TOOL_SERVER_CONNECTIONS: stored });
    }) as unknown as typeof fetch;
    return { impl, calls };
  };

  it('replaces only the D365FO connection, keeping the others', async () => {
    const other = { type: 'openapi', url: 'http://x', info: { id: 'mine' } };
    const { impl, calls } = fake([other, toolConnection({ toolUrl: 'http://127.0.0.1:1/tools', toolKey: 'old' })]);
    await syncToolServer('http://127.0.0.1:9', conn, 't0k', impl);
    const write = calls.find((c) => c.method === 'POST' && c.path.endsWith('/tool_servers'))!;
    assert.deepEqual(write.body.TOOL_SERVER_CONNECTIONS, [conn, other]);
  });

  it('writes nothing when the connection is already current', async () => {
    const { impl, calls } = fake([conn]);
    await syncToolServer('http://127.0.0.1:9', conn, 't0k', impl);
    assert.equal(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/tool_servers')).length, 0);
  });

  it('reports a refusal', async () => {
    await assert.rejects(syncToolServer('http://127.0.0.1:9', conn, 't0k', (async () => new Response('no', { status: 403 })) as unknown as typeof fetch), /403/);
  });

  describe('chat model connection', () => {
    const chat = { url: 'https://api.openai.com/v1', key: 'sk-new' };
    function fakeChat(cfg: Record<string, unknown>) {
      const calls: Array<{ path: string; body?: any }> = [];
      const impl = (async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify(path.endsWith('/signin') ? { token: 't' } : cfg), { status: 200 });
      }) as unknown as typeof fetch;
      return { impl, calls };
    }

    it('replaces the first connection and keeps the others', async () => {
      const { impl, calls } = fakeChat({ ENABLE_OPENAI_API: true, OPENAI_API_BASE_URLS: ['https://old', 'http://mine'], OPENAI_API_KEYS: ['k0', 'k1'], OPENAI_API_CONFIGS: { '1': { enable: true } } });
      await syncChatModel('http://127.0.0.1:9', chat, 't', impl);
      const w = calls.find((c) => c.path === '/openai/config/update')!;
      assert.deepEqual(w.body.OPENAI_API_BASE_URLS, ['https://api.openai.com/v1', 'http://mine']);
      assert.deepEqual(w.body.OPENAI_API_KEYS, ['sk-new', 'k1']);
      assert.deepEqual(w.body.OPENAI_API_CONFIGS['0'], { enable: true });
    });

    it('writes nothing when current, or when no connection is given', async () => {
      const { impl, calls } = fakeChat({ ENABLE_OPENAI_API: true, OPENAI_API_BASE_URLS: [chat.url], OPENAI_API_KEYS: [chat.key], OPENAI_API_CONFIGS: {} });
      await syncChatModel('http://127.0.0.1:9', chat, 't', impl);
      await syncChatModel('http://127.0.0.1:9', undefined, 't', impl);
      assert.equal(calls.filter((c) => c.path.endsWith('/update')).length, 0);
    });
  });
});
