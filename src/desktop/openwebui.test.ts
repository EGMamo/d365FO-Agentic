import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseConfig } from '../config/index.js';
import { chatConnection, install, isInstalled, layout, OPENWEBUI_VERSION, serveEnv } from './openwebui.js';

describe('desktop Open WebUI', () => {
  it('installs a pinned Open WebUI with uv into the app folder, and remembers the version', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'owui-'));
    const paths = { uv: '/bin/uv', dataRoot, platform: 'linux' as const };
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    await install(paths, () => {}, async (_cmd, args, env) => {
      calls.push({ args, env });
      return 0;
    });
    assert.equal(calls[0].args[0], 'venv');
    assert.ok(calls[1].args.includes(`open-webui==${OPENWEBUI_VERSION}`));
    assert.ok(calls[0].args.includes('--managed-python'));
    assert.ok(calls[1].args.includes('--torch-backend'), 'CPU PyTorch on Linux');
    assert.equal(calls[1].env.UV_PYTHON_INSTALL_DIR, join(dataRoot, 'openwebui', 'python'));
    assert.equal(await isInstalled(paths), false, 'no executable yet');
    const l = layout(paths);
    await mkdir(join(l.venv, 'bin'), { recursive: true });
    await writeFile(l.exe, '');
    assert.equal(await isInstalled(paths), true);
    assert.equal(await isInstalled(paths, '9.9.9'), false, 'a newer pin reinstalls');
  });

  it('stops with a clear message when uv fails', async () => {
    const paths = { uv: '/bin/uv', dataRoot: await mkdtemp(join(tmpdir(), 'owui-')) };
    await assert.rejects(install(paths, () => {}, async (_c, args) => (args[0] === 'pip' ? 1 : 0)), /Could not install Open WebUI/);
  });

  it('connects the tool server, skips sign-in and passes the chat model', () => {
    const env = serveEnv({ dataDir: '/d', toolUrl: 'http://127.0.0.1:4365/tools', toolKey: 'k', chat: { url: 'https://api.openai.com/v1', key: 'sk' } }, {});
    assert.equal(env.WEBUI_AUTH, 'False');
    assert.equal(env.DATA_DIR, '/d');
    const tools = JSON.parse(env.TOOL_SERVER_CONNECTIONS!);
    assert.equal(tools[0].url, 'http://127.0.0.1:4365/tools');
    assert.equal(tools[0].key, 'k');
    assert.equal(env.OPENAI_API_BASE_URL, 'https://api.openai.com/v1');
    assert.equal(serveEnv({ dataDir: '/d', toolUrl: 'u', toolKey: 'k' }, { NO_PROXY: 'corp.local' }).NO_PROXY, 'corp.local,127.0.0.1,localhost');
    assert.equal(serveEnv({ dataDir: '/d', toolUrl: 'u', toolKey: 'k' }, {}).OPENAI_API_KEY, undefined);
  });

  it('takes the chat model from profiles that speak an OpenAI-style API', () => {
    assert.deepEqual(chatConnection(parseConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' })), { url: 'https://api.anthropic.com/v1', key: 'a' });
    assert.deepEqual(chatConnection(parseConfig({ LLM_PROVIDER: 'openai-compatible', OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:11434/v1/', OPENAI_COMPATIBLE_MODEL: 'm' })), { url: 'http://localhost:11434/v1', key: '' });
    assert.equal(chatConnection(parseConfig({ LLM_PROVIDER: 'github-copilot' })), undefined);
    assert.equal(chatConnection(parseConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a', ANTHROPIC_BASE_URL: 'https://gw' })), undefined);
  });
});
