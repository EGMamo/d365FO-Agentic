import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LlmCompleteRequest, LlmCompleteResponse, LlmProvider } from '../llm/types.js';
import { callTool, chatTools, chatTurn, parseHistory } from './chat.js';
import { startUiServer, type RunningUi } from './server.js';
import { openApiSpec } from './tools.js';

/** A model that plays back scripted replies and records what it was sent. */
function scripted(replies: LlmCompleteResponse[]): LlmProvider & { seen: LlmCompleteRequest[] } {
  const seen: LlmCompleteRequest[] = [];
  return {
    name: 'fake',
    seen,
    complete: async (req) => {
      seen.push(structuredClone(req));
      return replies.shift() ?? { text: 'done', toolCalls: [], stopReason: 'end_turn' };
    },
  };
}

describe('chat tools', () => {
  const set = chatTools(openApiSpec('http://127.0.0.1:1/tools'));

  it('offers every tool-server operation with its parameters', () => {
    const names = set.tools.map((t) => t.name);
    for (const n of ['list_profiles', 'start_run', 'get_run', 'get_results', 'save_test_case', 'upload_run', 'check_setup']) assert.ok(names.includes(n), n);
    const save = set.tools.find((t) => t.name === 'save_test_case')!.inputSchema as { properties: Record<string, unknown>; required: string[] };
    assert.deepEqual(Object.keys(save.properties).sort(), ['dir', 'file', 'testCase']);
    assert.deepEqual(save.required.sort(), ['dir', 'testCase']);
  });

  it('sends query, path and body arguments where the route expects them', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;
    assert.equal(await callTool(set, 'http://h/tools', 'k', 'upload_run', { id: 'r 1', plan: '7' }, fake), '{"ok":true}');
    await callTool(set, 'http://h/tools', 'k', 'save_test_case', { dir: 'examples/testcases', testCase: { title: 'T', steps: [] } }, fake);
    await callTool(set, 'http://h/tools', 'k', 'get_run', { waitSeconds: 30 }, fake);
    assert.equal(calls[0].url, 'http://h/tools/history/r%201/upload');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { plan: '7' });
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer k');
    assert.equal(calls[1].url, 'http://h/tools/testcases?dir=examples%2Ftestcases');
    assert.equal(calls[1].init.method, 'PUT');
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), { testCase: { title: 'T', steps: [] } });
    assert.equal(calls[2].url, 'http://h/tools/runs/current?waitSeconds=30');
    assert.equal(calls[2].init.body, undefined);
    assert.match(await callTool(set, 'http://h/tools', 'k', 'nope', {}, fake), /Unknown tool/);
  });
});

describe('chat turn', () => {
  it('runs tool calls until the model answers, and feeds each result back', async () => {
    const model = scripted([
      { text: '', toolCalls: [{ id: 't1', name: 'list_profiles', arguments: {} }], stopReason: 'tool_use' },
      { text: 'You have one profile, Sandbox.', toolCalls: [], stopReason: 'end_turn' },
    ]);
    const turn = await chatTurn(model, [{ role: 'user', content: 'which profiles?' }], [], async (name) => `{"tool":"${name}"}`);
    assert.deepEqual(turn, { reply: 'You have one profile, Sandbox.', used: ['list_profiles'] });
    const last = model.seen[1].messages.at(-1)!;
    assert.equal(last.role, 'tool');
    assert.equal(last.toolCallId, 't1');
    assert.equal(last.content, '{"tool":"list_profiles"}');
  });

  it('stops after the step limit', async () => {
    const loop: LlmCompleteResponse = { text: '', toolCalls: [{ id: 'x', name: 'get_run', arguments: {} }], stopReason: 'tool_use' };
    const model = scripted([loop, loop, loop]);
    const turn = await chatTurn(model, [{ role: 'user', content: 'hi' }], [], async () => '{}', 2);
    assert.match(turn.reply, /stopped/);
    assert.equal(turn.used.length, 2);
  });

  it('accepts only user and assistant text, ending with the user', () => {
    assert.deepEqual(parseHistory([{ role: 'system', content: 'x' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]), [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
    assert.equal(parseHistory([{ role: 'assistant', content: 'b' }]), undefined);
    assert.equal(parseHistory('nope'), undefined);
  });
});

describe('chat endpoint', () => {
  let ui: RunningUi;
  let cookie = '';
  const model = scripted([]);
  const post = (path: string, body: unknown): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = request(
        { host: '127.0.0.1', port: ui.port, method: 'POST', path, headers: { host: `127.0.0.1:${ui.port}`, cookie, 'x-requested-with': 'd365fo-ui', 'content-type': 'application/json' } },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
        },
      );
      req.on('error', reject);
      req.end(data);
    });

  before(async () => {
    ui = await startUiServer({ home: await mkdtemp(join(tmpdir(), 'chat-')), port: 0, chatProvider: () => model, childEnv: () => ({}) });
    cookie = await new Promise((resolve) => {
      request({ host: '127.0.0.1', port: ui.port, path: `/?token=${ui.token}`, headers: { host: `127.0.0.1:${ui.port}` } }, (res) => {
        res.resume();
        resolve(String(res.headers['set-cookie']).split(';')[0]);
      }).end();
    });
  });
  after(() => ui.close());

  it('asks for an AI model first', async () => {
    const r = await post('/api/chat', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /AI model/);
  });

  it('answers with the chat AI model and real tool results', async () => {
    assert.equal((await post('/api/profiles', { name: 'Sandbox', entries: [] })).status, 201);
    assert.equal((await post('/api/models', { name: 'Claude', entries: [{ key: 'LLM_PROVIDER', value: 'anthropic' }] })).status, 201);
    await post('/api/active', { name: 'Sandbox' });
    model.seen.length = 0;
    const replies: LlmCompleteResponse[] = [
      { text: '', toolCalls: [{ id: 'a', name: 'list_profiles', arguments: {} }], stopReason: 'tool_use' },
      { text: 'Sandbox is in use.', toolCalls: [], stopReason: 'end_turn' },
    ];
    model.complete = async (req) => {
      model.seen.push(structuredClone(req));
      return replies.shift()!;
    };
    const r = await post('/api/chat', { messages: [{ role: 'user', content: 'which profile?' }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { reply: 'Sandbox is in use.', used: ['list_profiles'] });
    const toolResult = JSON.parse(model.seen[1].messages.at(-1)!.content);
    assert.equal(toolResult.active, 'Sandbox');
    assert.ok(model.seen[0].tools!.some((t) => t.name === 'start_run'));
  });
});
