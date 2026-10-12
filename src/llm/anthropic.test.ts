import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { AnthropicProvider, anthropicClientOptions } from './anthropic.js';
import { checkAnthropicEndpoint, normalizeAnthropicBaseUrl } from './endpoint.js';
import { createLlmProvider } from './index.js';
import { parseConfig, validateForRun } from '../config/index.js';
import type { LlmMessage } from './types.js';

type Captured = { system?: Array<Record<string, unknown>>; messages: Array<{ role: string; content: unknown }>; tools: unknown[] };

function provider(opts: { promptCache?: boolean }, usage: Record<string, number> = { input_tokens: 10, output_tokens: 5 }) {
  const seen: Captured[] = [];
  const client = {
    messages: {
      async create(params: Captured) {
        seen.push(JSON.parse(JSON.stringify(params)) as Captured);
        return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage };
      },
    },
  };
  return { seen, llm: new AnthropicProvider({ apiKey: 'k', model: 'm', maxTokens: 10, temperature: 0, client: client as never, ...opts }) };
}

const convo: LlmMessage[] = [
  { role: 'user', content: 'Run it' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'playwright__browser_snapshot', arguments: {} }] },
  { role: 'tool', toolName: 'playwright__browser_snapshot', toolCallId: 'c1', content: 'page tree' },
];

describe('anthropic prompt caching', () => {
  it('marks the system prompt and the last message block as cache breakpoints', async () => {
    const { seen, llm } = provider({});
    await llm.complete({ system: 'You are QA', messages: convo, tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }] });
    const req = seen[0];
    assert.deepEqual(req.system, [{ type: 'text', text: 'You are QA', cache_control: { type: 'ephemeral' } }]);
    const last = req.messages.at(-1)!.content as Array<Record<string, unknown>>;
    assert.equal(last.at(-1)?.type, 'tool_result');
    assert.deepEqual(last.at(-1)?.cache_control, { type: 'ephemeral' });
    const breakpoints = JSON.stringify(req).match(/cache_control/g)?.length;
    assert.equal(breakpoints, 2, 'stays well under the API limit of 4');
  });

  it('caches a plain-text last message too, and never an empty block', async () => {
    const { seen, llm } = provider({});
    await llm.complete({ system: 's', messages: [{ role: 'user', content: 'hello' }] });
    assert.deepEqual(seen[0].messages[0].content, [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]);
    await llm.complete({ system: 's', messages: [{ role: 'user', content: '' }] });
    assert.equal(seen[1].messages[0].content, '');
  });

  it('sends no cache_control when disabled', async () => {
    const { seen, llm } = provider({ promptCache: false });
    await llm.complete({ system: 'You are QA', messages: convo });
    assert.ok(!JSON.stringify(seen[0]).includes('cache_control'));
  });

  it('reports cache read/write token counts', async () => {
    const { llm } = provider({}, { input_tokens: 40, output_tokens: 7, cache_read_input_tokens: 900, cache_creation_input_tokens: 120 });
    const res = await llm.complete({ system: 's', messages: convo });
    assert.deepEqual(res.usage, { inputTokens: 40, outputTokens: 7, cacheReadTokens: 900, cacheWriteTokens: 120 });
  });

  it('leaves the caller-owned messages untouched', async () => {
    const { llm } = provider({});
    const before = JSON.stringify(convo);
    await llm.complete({ system: 's', messages: convo });
    assert.equal(JSON.stringify(convo), before);
  });
});

describe('custom Claude API URL', () => {
  it('accepts the address in the forms people paste it', () => {
    for (const url of ['https://gw.example/anthropic', 'https://gw.example/anthropic/', ' https://gw.example/anthropic/v1 ', 'https://gw.example/anthropic/v1/messages', 'https://gw.example/anthropic/V1/']) {
      assert.equal(normalizeAnthropicBaseUrl(url), 'https://gw.example/anthropic', url);
    }
    assert.equal(normalizeAnthropicBaseUrl('http://localhost:4000'), 'http://localhost:4000');
    assert.equal(normalizeAnthropicBaseUrl(''), undefined);
    assert.equal(normalizeAnthropicBaseUrl(undefined), undefined);
  });

  it('builds client options from exactly what is configured', () => {
    assert.deepEqual(anthropicClientOptions({ apiKey: 'k' }), { apiKey: 'k', authToken: null, baseURL: 'https://api.anthropic.com' });
    assert.deepEqual(anthropicClientOptions({ authToken: 't', baseURL: 'https://gw.example/v1' }), { apiKey: null, authToken: 't', baseURL: 'https://gw.example' });
  });

  it('sends requests to the configured address with the configured credentials', async () => {
    const seen: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers });
      req.resume();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic`;
    try {
      const withKey = new AnthropicProvider({ apiKey: 'sk-test', baseURL: `${base}/v1`, model: 'm', maxTokens: 10, temperature: 0 });
      assert.equal((await withKey.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] })).text, 'ok');
      const withToken = new AnthropicProvider({ authToken: 'tok-test', baseURL: base, model: 'm', maxTokens: 10, temperature: 0 });
      await withToken.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] });
    } finally {
      server.close();
    }
    assert.equal(seen[0]!.url, '/anthropic/v1/messages');
    assert.equal(seen[0]!.headers['x-api-key'], 'sk-test');
    assert.equal(seen[1]!.url, '/anthropic/v1/messages');
    assert.equal(seen[1]!.headers.authorization, 'Bearer tok-test');
    assert.equal(seen[1]!.headers['x-api-key'], undefined);
  });

  it('reads the settings from configuration and validates them', () => {
    const env = (over: Record<string, string>) => parseConfig({ D365_BASE_URL: 'https://x.sandbox.operations.dynamics.com', D365_USERNAME: 'u', D365_PASSWORD: 'p', ...over });
    const ok = env({ ANTHROPIC_BASE_URL: ' https://gw.example/anthropic ', ANTHROPIC_AUTH_TOKEN: 'tok' });
    assert.equal(ok.ANTHROPIC_BASE_URL, 'https://gw.example/anthropic');
    assert.deepEqual(validateForRun(ok).filter((i) => /ANTHROPIC/.test(i)), []);
    assert.equal(createLlmProvider(ok).name, 'anthropic');
    assert.match(validateForRun(env({ ANTHROPIC_BASE_URL: 'gw.example' })).join('\n'), /ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is required for the custom Claude API URL[\s\S]*not a valid http\(s\) URL/);
    assert.match(validateForRun(env({})).join('\n'), /ANTHROPIC_API_KEY is required for provider=anthropic/);
  });

  it('checks a custom endpoint: reachable, refused, no model list, unreachable', async () => {
    const reply = (status: number, body: unknown = {}) => (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      assert.equal(String(url), 'https://gw.example/v1/models');
      assert.equal(init?.headers?.['x-api-key'], 'k');
      return new Response(JSON.stringify(body), { status });
    }) as never;
    const listed = await checkAnthropicEndpoint('https://gw.example/v1', { apiKey: 'k' }, 1000, reply(200, { data: [{ id: 'claude-a' }, { id: 'claude-b' }] }));
    assert.deepEqual([listed.reachable, listed.authorized, listed.models], [true, true, ['claude-a', 'claude-b']]);
    const refused = await checkAnthropicEndpoint('https://gw.example', { apiKey: 'k' }, 1000, reply(401));
    assert.deepEqual([refused.reachable, refused.authorized], [true, false]);
    const noList = await checkAnthropicEndpoint('https://gw.example', { apiKey: 'k' }, 1000, reply(404));
    assert.deepEqual([noList.reachable, noList.authorized, noList.models], [true, true, []]);
    const down = await checkAnthropicEndpoint('https://gw.example', { apiKey: 'k' }, 1000, (async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) as never);
    assert.deepEqual([down.reachable, down.detail], [false, 'ECONNREFUSED']);
  });
});
