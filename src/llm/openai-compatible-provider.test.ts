import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { activeModel, ignoredModelHint, validateForRun, type AppConfig } from '../config/index.js';
import { redactSecrets } from '../d365fo/login.js';
import { checkModelEndpoint } from './endpoint.js';
import { createLlmProvider, isLoopbackUrl } from './index.js';

const cfg = (over: Partial<AppConfig> = {}): AppConfig =>
  ({
    LLM_PROVIDER: 'openai-compatible', LLM_MAX_TOKENS: 100, LLM_TEMPERATURE: 0, LLM_HTTP_TIMEOUT_MS: 1000, LLM_HTTP_MAX_RETRIES: 0, LLM_HTTP_RETRY_BASE_MS: 1,
    OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:11434/v1', OPENAI_COMPATIBLE_MODEL: 'qwen3:8b',
    D365_BASE_URL: 'https://x.sandbox.operations.dynamics.com', D365_USERNAME: 'u', D365_PASSWORD: 'p', ...over,
  }) as AppConfig;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubChat(body: unknown) {
  const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return seen;
}

const reply = (message: Record<string, unknown>, finish_reason: string) => ({ choices: [{ message, finish_reason }], usage: { prompt_tokens: 5, completion_tokens: 2 } });

describe('openai-compatible config', () => {
  it('needs a model and a valid URL', () => {
    assert.deepEqual(validateForRun(cfg()).filter((i) => /OPENAI_COMPATIBLE/.test(i)), []);
    assert.match(validateForRun(cfg({ OPENAI_COMPATIBLE_MODEL: undefined })).join('\n'), /OPENAI_COMPATIBLE_MODEL is required/);
    assert.match(validateForRun(cfg({ OPENAI_COMPATIBLE_BASE_URL: 'localhost:11434' })).join('\n'), /not a valid http\(s\) URL/);
  });

  it('needs no API key, and reports the configured model', () => {
    assert.ok(!validateForRun(cfg()).some((i) => /API_KEY|KEY is required/.test(i)));
    assert.equal(activeModel(cfg()), 'qwen3:8b');
    assert.equal(activeModel(cfg({ OPENAI_COMPATIBLE_MODEL: undefined })), '(missing)');
  });

  it('refuses to build a provider without a model', () => {
    assert.throws(() => createLlmProvider(cfg({ OPENAI_COMPATIBLE_MODEL: undefined })), /OPENAI_COMPATIBLE_MODEL is required/);
  });

  it('never leaks its API key into stored text', () => {
    assert.equal(redactSecrets({ OPENAI_COMPATIBLE_API_KEY: 'local-key-123' }, 'see local-key-123'), 'see ***');
  });

  it('recognises loopback addresses', () => {
    for (const u of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1']) assert.equal(isLoopbackUrl(u), true, u);
    for (const u of ['https://openrouter.ai/api/v1', 'http://192.168.1.20:11434/v1', 'nonsense']) assert.equal(isLoopbackUrl(u), false, u);
  });
});

describe('openai-compatible provider requests', () => {
  const ask = { messages: [{ role: 'user' as const, content: 'hi' }], tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }] };

  it('posts to <base>/chat/completions with the configured model and no Authorization header when keyless', async () => {
    const seen = stubChat(reply({ content: 'ok' }, 'stop'));
    const res = await createLlmProvider(cfg({ OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:11434/v1/' })).complete(ask);
    assert.equal(seen[0].url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(seen[0].body.model, 'qwen3:8b');
    assert.ok(!('authorization' in seen[0].headers), 'no empty bearer token');
    assert.equal(res.text, 'ok');
    assert.equal(res.stopReason, 'end_turn');
  });

  it('sends the key as a bearer token when one is configured (hosted endpoints)', async () => {
    const seen = stubChat(reply({ content: 'ok' }, 'stop'));
    await createLlmProvider(cfg({ OPENAI_COMPATIBLE_BASE_URL: 'https://openrouter.ai/api/v1', OPENAI_COMPATIBLE_API_KEY: 'sk-or-123' })).complete(ask);
    assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(seen[0].headers.authorization, 'Bearer sk-or-123');
  });

  it('treats tool calls as tool use even when the server says finish_reason "stop"', async () => {
    stubChat(reply({ content: '', tool_calls: [{ id: 'c1', function: { name: 'playwright__browser_navigate', arguments: '{"url":"https://x"}' } }] }, 'stop'));
    const res = await createLlmProvider(cfg()).complete(ask);
    assert.equal(res.stopReason, 'tool_use');
    assert.deepEqual(res.toolCalls, [{ id: 'c1', name: 'playwright__browser_navigate', arguments: { url: 'https://x' } }]);
  });

  it('merges a reply that a server split across choices (Copilot + Claude: text first, tool call second)', async () => {
    stubChat({
      choices: [
        { message: { content: "I'll navigate to the F&O URL." }, finish_reason: 'tool_calls' },
        { message: { content: '', tool_calls: [{ id: 'toolu_1', function: { name: 'playwright__browser_navigate', arguments: '{"url":"https://x"}' } }] }, finish_reason: 'tool_calls' },
      ],
    });
    const res = await createLlmProvider(cfg()).complete(ask);
    assert.equal(res.text, "I'll navigate to the F&O URL.");
    assert.deepEqual(res.toolCalls, [{ id: 'toolu_1', name: 'playwright__browser_navigate', arguments: { url: 'https://x' } }]);
    assert.equal(res.stopReason, 'tool_use');
  });

  it('copes with a reply that has no choices at all', async () => {
    stubChat({ choices: [] });
    const res = await createLlmProvider(cfg()).complete(ask);
    assert.deepEqual([res.text, res.toolCalls, res.stopReason], ['', [], 'other']);
  });

  it('still reports a truncated reply as max_tokens', async () => {
    stubChat(reply({ content: 'thinking about it' }, 'length'));
    assert.equal((await createLlmProvider(cfg()).complete(ask)).stopReason, 'max_tokens');
  });
});

describe('checkModelEndpoint', () => {
  const fake = (impl: () => Promise<Response>) => impl as unknown as typeof fetch;

  it('lists the models a reachable server offers', async () => {
    let asked = '';
    const f = (async (url: string) => { asked = url; return new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }, {}] })); }) as unknown as typeof fetch;
    assert.deepEqual(await checkModelEndpoint('http://localhost:11434/v1/', undefined, 1000, f), { reachable: true, models: ['a', 'b'] });
    assert.equal(asked, 'http://localhost:11434/v1/models');
  });

  it('reports a server that is not running', async () => {
    const down = fake(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
    assert.deepEqual(await checkModelEndpoint('http://localhost:1/v1', undefined, 1000, down), { reachable: false, models: [], error: 'ECONNREFUSED' });
  });

  it('is reachable but tolerant when /models is unsupported or not JSON', async () => {
    assert.deepEqual(await checkModelEndpoint('http://x/v1', undefined, 1000, fake(async () => new Response('nope', { status: 404 }))), { reachable: true, models: [], error: 'HTTP 404 from /models' });
    assert.deepEqual(await checkModelEndpoint('http://x/v1', undefined, 1000, fake(async () => new Response('<html>'))), { reachable: true, models: [] });
  });

  it('gives up on a server that never answers', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as unknown as typeof fetch;
    const res = await checkModelEndpoint('http://x/v1', undefined, 30, hang);
    assert.equal(res.reachable, false);
    assert.match(res.error ?? '', /no answer within/);
  });
});

describe('ignoredModelHint', () => {
  const copilot = cfg({ LLM_PROVIDER: 'github-copilot', GITHUB_COPILOT_MODEL: 'gpt-4.1' });

  it('explains that LLM_MODEL does nothing for other providers, naming the variable that does', () => {
    const hint = ignoredModelHint(copilot, { LLM_MODEL: 'claude-sonnet-5.5' });
    assert.match(hint ?? '', /LLM_MODEL=claude-sonnet-5\.5 is ignored.*only applies to provider=anthropic.*uses GITHUB_COPILOT_MODEL.*runs gpt-4\.1/);
    assert.match(ignoredModelHint(cfg(), { LLM_MODEL: 'x' }) ?? '', /uses OPENAI_COMPATIBLE_MODEL/);
  });

  it('stays quiet when it does not apply', () => {
    assert.equal(ignoredModelHint(copilot, {}), undefined);
    assert.equal(ignoredModelHint(copilot, { LLM_MODEL: '  ' }), undefined);
    assert.equal(ignoredModelHint(copilot, { LLM_MODEL: 'x', GITHUB_COPILOT_MODEL: 'claude-sonnet-5.5' }), undefined, 'the right variable is set too');
    assert.equal(ignoredModelHint(cfg({ LLM_PROVIDER: 'anthropic' }), { LLM_MODEL: 'x' }), undefined, 'LLM_MODEL is the anthropic variable');
  });
});
