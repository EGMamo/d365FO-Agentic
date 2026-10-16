import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it } from 'node:test';
import { AiSettings } from '../profiles/ai.js';
import { completionRequest } from './completions.js';
import { startUiServer } from './server.js';
import type { LlmCompleteRequest } from '../llm/types.js';

it('translates native tool history and includes the confirmation instructions', () => {
  const r = completionRequest({
    messages: [
      { role: 'system', content: 'Use the chosen environment.' },
      { role: 'user', content: [{ type: 'text', text: 'Check setup' }] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'a', function: { name: 'check_setup', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'a', content: 'Ready' },
    ],
    tools: [{ type: 'function', function: { name: 'check_setup', parameters: { type: 'object' } } }],
  });
  assert.match(r.system!, /wait for the user to confirm/);
  assert.equal(r.messages[0].content, 'Check setup');
  assert.deepEqual(r.messages[1].toolCalls, [{ id: 'a', name: 'check_setup', arguments: {} }]);
  assert.equal(r.messages[2].toolCallId, 'a');
  assert.equal(r.tools?.[0].name, 'check_setup');
  assert.throws(
    () => completionRequest({ messages: [{ role: 'assistant', tool_calls: [{ function: { arguments: '{bad' } }] }] }),
    /Invalid tool-call/,
  );
});

it('authenticates the model bridge, uses the shared connection, streams tool calls, and scrubs errors', async () => {
  const home = await mkdtemp(join(tmpdir(), 'model-bridge-'));
  const ai = new AiSettings(home);
  await ai.write([
    { key: 'ANTHROPIC_API_KEY', value: 'private-test-key' },
    { key: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example/claude' },
  ]);
  let request: LlmCompleteRequest | undefined;
  let fail = false;
  const ui = await startUiServer({
    home,
    port: 0,
    modelProvider: (cfg) => {
      assert.equal(cfg.ANTHROPIC_API_KEY, 'private-test-key');
      assert.equal(cfg.ANTHROPIC_BASE_URL, 'https://gateway.example/claude');
      return {
        name: 'fake',
        async complete(r) {
          if (fail) throw new Error('rejected private-test-key');
          request = r;
          return { text: '', toolCalls: [{ id: 't1', name: 'check_setup', arguments: {} }], stopReason: 'tool_use' };
        },
      };
    },
  });
  try {
    const headers = { Authorization: `Bearer ${ui.toolToken}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(ui.url + 'model/v1/models')).status, 401);
    assert.equal(
      ((await (await fetch(ui.url + 'model/v1/models', { headers })).json()) as any).data[0].id,
      'd365fo-claude',
    );
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'Check setup' }], stream: true });
    const response = await fetch(ui.url + 'model/v1/chat/completions', { method: 'POST', headers, body });
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const events = await response.text();
    assert.match(events, /"tool_calls".*"check_setup"/);
    assert.match(events, /\[DONE\]/);
    assert.equal(request?.messages[0].content, 'Check setup');
    fail = true;
    const error = await fetch(ui.url + 'model/v1/chat/completions', { method: 'POST', headers, body });
    assert.equal(error.status, 502);
    assert.doesNotMatch(await error.text(), /private-test-key/);
  } finally {
    await ui.close();
  }
});
