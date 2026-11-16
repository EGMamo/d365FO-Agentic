import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { LlmCompleteRequest, LlmCompleteResponse, LlmProvider } from '../../llm/types.js';
import { ChatService } from './service.js';
import { JsonChatRepository } from './store.js';
import type { ChatEvent, ChatTool } from './types.js';

const answer = (text: string, toolCalls: LlmCompleteResponse['toolCalls'] = []): LlmCompleteResponse => ({ text, toolCalls, stopReason: toolCalls.length ? 'tool_use' : 'end_turn' });

async function setup(responses: LlmCompleteResponse[], tools: ChatTool[] = []) {
  const repository = new JsonChatRepository(await mkdtemp(join(tmpdir(), 'chat-service-')));
  const { id } = await repository.create();
  const requests: LlmCompleteRequest[] = [];
  const provider: LlmProvider = {
    name: 'fake',
    async complete(req) {
      requests.push(structuredClone(req));
      const next = responses.shift();
      if (!next) throw new Error('No fake answer left');
      return next;
    },
  };
  const events: ChatEvent[] = [];
  const service = new ChatService({ repository, provider: () => provider, tools: () => tools, maxTurns: 4 });
  return { repository, id, requests, events, service, publish: (event: ChatEvent) => events.push(event) };
}

describe('ChatService', () => {
  it('answers through the injected provider and persists the user and assistant messages', async () => {
    const s = await setup([answer('The setup is healthy.')]);
    await s.service.send(s.id, 'How is UAT?', undefined, s.publish);
    const chat = await s.repository.get(s.id);
    assert.deepEqual(chat.messages.map((m) => [m.role, m.content]), [['user', 'How is UAT?'], ['assistant', 'The setup is healthy.']]);
    assert.match(s.requests[0].system ?? '', /D365FO test assistant/);
    assert.deepEqual(s.requests[0].messages[0], { role: 'user', content: 'How is UAT?', toolCallId: undefined, toolCalls: undefined, toolName: undefined });
    assert.equal(s.events.at(-1)?.type, 'done');
  });

  it('executes a model tool call and returns its result on the next model turn, in order', async () => {
    const calls: unknown[] = [];
    const tool: ChatTool = {
      definition: { name: 'check_setup', description: 'Check setup', inputSchema: { type: 'object' } },
      execute: async (args) => {
        calls.push(args);
        return { exitCode: 0, output: 'Configuration looks good.' };
      },
    };
    const s = await setup([
      answer('', [{ id: 'tool-1', name: 'check_setup', arguments: { detailed: true } }]),
      answer('UAT setup passed.'),
    ], [tool]);
    await s.service.send(s.id, 'Check it', undefined, s.publish);
    assert.deepEqual(calls, [{ detailed: true }]);
    const messages = (await s.repository.get(s.id)).messages;
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
    assert.equal(messages[1].toolCalls?.[0].name, 'check_setup');
    assert.deepEqual(messages[2], { ...messages[2], toolCallId: 'tool-1', toolName: 'check_setup', content: '{"exitCode":0,"output":"Configuration looks good."}' });
    assert.equal(JSON.parse(s.requests[1].messages[2].content).exitCode, 0);
    assert.ok(s.events.some((e) => e.type === 'tool' && e.status === 'running'));
  });

  it('returns tool failures to the model instead of losing the conversation', async () => {
    const tool: ChatTool = {
      definition: { name: 'broken', description: '', inputSchema: {} },
      execute: async () => { throw new Error('Choose an environment first.'); },
    };
    const s = await setup([
      answer('', [{ id: 'x', name: 'broken', arguments: {} }]),
      answer('Choose an environment first.'),
    ], [tool]);
    await s.service.send(s.id, 'Run it', undefined, s.publish);
    assert.equal(JSON.parse(s.requests[1].messages[2].content).error, 'Choose an environment first.');
  });

  it('stops a model that keeps requesting tools instead of turning forever', async () => {
    const tool: ChatTool = { definition: { name: 'again', description: '', inputSchema: {} }, execute: async () => ({ again: true }) };
    const s = await setup(Array.from({ length: 4 }, () => answer('', [{ id: 'x', name: 'again', arguments: {} }])), [tool]);
    await assert.rejects(() => s.service.send(s.id, 'Loop', undefined, s.publish), /too many consecutive model turns/);
    assert.equal((await s.repository.get(s.id)).messages.at(-1)?.role, 'tool');
  });

  it('does not invent an assistant answer when the provider fails', async () => {
    const repository = new JsonChatRepository(await mkdtemp(join(tmpdir(), 'chat-outage-')));
    const { id } = await repository.create();
    const provider: LlmProvider = { name: 'fake', complete: async () => { throw new Error('Provider unavailable'); } };
    const service = new ChatService({ repository, provider: () => provider, tools: () => [] });
    await assert.rejects(() => service.send(id, 'Hello', undefined, () => undefined), /Provider unavailable/);
    assert.deepEqual((await repository.get(id)).messages.map((m) => m.role), ['user']);
  });

  it('does not persist an empty assistant answer', async () => {
    const s = await setup([answer('   ')]);
    await assert.rejects(() => s.service.send(s.id, 'Hello', undefined, s.publish), /empty answer/);
    assert.deepEqual((await s.repository.get(s.id)).messages.map((m) => m.role), ['user']);
  });

  it('settles every tool call when the user stops in the middle of a batch', async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const tool = (name: string): ChatTool => ({
      definition: { name, description: '', inputSchema: {} },
      execute: async () => {
        executed.push(name);
        if (name === 'first') controller.abort();
        return { ok: name };
      },
    });
    const s = await setup([
      answer('', [{ id: 'a', name: 'first', arguments: {} }, { id: 'b', name: 'second', arguments: {} }]),
    ], [tool('first'), tool('second')]);
    await assert.rejects(() => s.service.send(s.id, 'Run both', controller.signal, s.publish));
    assert.deepEqual(executed, ['first']);
    const messages = (await s.repository.get(s.id)).messages;
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'tool']);
    assert.deepEqual(messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId), ['a', 'b']);
    assert.match(messages[3].content, /Stopped by the user/);
  });

  it('bounds the prompt window while keeping tool calls paired with their results', async () => {
    const repository = new JsonChatRepository(await mkdtemp(join(tmpdir(), 'chat-window-')));
    const { id } = await repository.create('window');
    const big = 'x'.repeat(60_000);
    await repository.append(id, [
      { role: 'user', content: `old user ${big}` },
      { role: 'assistant', content: `old answer ${big}` },
      { role: 'user', content: `current user ${big}` },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'again', arguments: {} }] },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'call', toolName: 'again' },
    ]);
    const requests: LlmCompleteRequest[] = [];
    const provider: LlmProvider = {
      name: 'fake',
      complete: async (req) => {
        requests.push(structuredClone(req));
        return answer('Done.');
      },
    };
    const service = new ChatService({ repository, provider: () => provider, tools: () => [], maxContextChars: 100_000 });
    await service.send(id, 'new question', undefined, () => undefined);
    const sent = requests[0].messages;
    assert.deepEqual(sent.map((message) => message.role), ['user', 'assistant', 'tool', 'user']);
    assert.match(sent[0].content, /^current user/);
    assert.equal(sent[2].toolCallId, 'call');
    assert.equal(sent[3].content, 'new question');
    assert.ok(sent.reduce((total, message) => total + message.content.length, 0) <= 100_000);
    assert.equal((await repository.get(id)).messages.length, 7, 'full history stays persisted');
  });
});
