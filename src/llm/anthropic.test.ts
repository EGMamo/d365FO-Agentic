import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AnthropicProvider } from './anthropic.js';
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
