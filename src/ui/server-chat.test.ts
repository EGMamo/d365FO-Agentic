import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { LlmCompleteRequest, LlmCompleteResponse } from '../llm/types.js';
import { ProfileStore } from '../profiles/store.js';
import { startUiServer, type RunningUi, type ToolActionApproval } from './server.js';
import type { ChatConversation, ChatEvent } from './chat/types.js';

const answer = (text: string, toolCalls: LlmCompleteResponse['toolCalls'] = []): LlmCompleteResponse => ({ text, toolCalls, stopReason: toolCalls.length ? 'tool_use' : 'end_turn' });

async function api(ui: RunningUi, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(path, ui.url), {
    method,
    headers: { cookie: `d365fo_ui=${ui.token}`, 'x-requested-with': 'd365fo-ui', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function events(raw: string): ChatEvent[] {
  return raw.split('\n\n').filter(Boolean).map((line) => JSON.parse(line.replace(/^data: /, '')) as ChatEvent);
}

describe('owned Chat HTTP API', () => {
  it('persists conversations and completes an answer over SSE through the shared provider', async () => {
    let calls = 0;
    const ui = await startUiServer({
      home: await mkdtemp(join(tmpdir(), 'chat-http-')), port: 0, childEnv: () => ({}),
      modelProvider: () => ({ name: 'fake', complete: async () => { calls++; return answer('Hello from the app.'); } }),
    });
    try {
      const initial = await api(ui, 'GET', '/api/chat/conversations');
      assert.deepEqual(await initial.json(), { conversations: [] });
      const created = await (await api(ui, 'POST', '/api/chat/conversations')).json() as ChatConversation;
      const reply = await api(ui, 'POST', `/api/chat/conversations/${created.id}/messages`, { text: 'Hello' });
      assert.match(reply.headers.get('content-type') ?? '', /text\/event-stream/);
      const streamed = events(await reply.text());
      assert.equal(streamed.at(-1)?.type, 'done');
      assert.equal(calls, 1);
      const saved = await (await api(ui, 'GET', `/api/chat/conversations/${created.id}`)).json() as ChatConversation;
      assert.deepEqual(saved.messages.map((m) => [m.role, m.content]), [['user', 'Hello'], ['assistant', 'Hello from the app.']]);
      const renamed = await (await api(ui, 'PATCH', `/api/chat/conversations/${created.id}`, { title: 'First conversation' })).json() as ChatConversation;
      assert.equal(renamed.title, 'First conversation');
      assert.deepEqual(await (await api(ui, 'DELETE', `/api/chat/conversations/${created.id}`)).json(), { deleted: true });
      assert.equal((await api(ui, 'GET', `/api/chat/conversations/${created.id}`)).status, 404);
    } finally {
      await ui.close();
    }
  });

  it('keeps native approval on the direct Chat tool path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chat-approval-'));
    const store = new ProfileStore(home);
    await store.write('UAT', [{ key: 'D365_BASE_URL', value: 'https://uat.sandbox.operations.dynamics.com' }, { key: 'D365_COMPANY', value: 'USMF' }], 'create');
    await store.setActive('UAT');
    const approvals: ToolActionApproval[] = [];
    const requests: LlmCompleteRequest[] = [];
    const responses = [
      answer('', [{ id: 'run-1', name: 'start_run', arguments: { source: 'local', local: 'examples/testcases', dryRun: false } }]),
      answer('I could not start the run.'),
    ];
    const ui = await startUiServer({
      home, port: 0, childEnv: () => ({}),
      approveToolAction: async (action) => { approvals.push(action); return false; },
      modelProvider: () => ({ name: 'fake', complete: async (req) => { requests.push(structuredClone(req)); return responses.shift()!; } }),
    });
    try {
      const { id } = await (await api(ui, 'POST', '/api/chat/conversations')).json() as ChatConversation;
      const reply = await api(ui, 'POST', `/api/chat/conversations/${id}/messages`, { text: 'Run the examples against UAT' });
      const streamed = events(await reply.text());
      assert.equal(streamed.at(-1)?.type, 'done');
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0].profile, 'UAT');
      assert.ok((approvals[0].cases ?? []).includes('TC-SMOKE-LOGIN'));
      const toolMessage = requests[1].messages.find((m) => m.role === 'tool');
      assert.match(toolMessage?.content ?? '', /not approved/);
    } finally {
      await ui.close();
    }
  });

  it('stops an in-flight answer without persisting a late reply', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ui = await startUiServer({
      home: await mkdtemp(join(tmpdir(), 'chat-cancel-')), port: 0, childEnv: () => ({}),
      modelProvider: () => ({ name: 'slow', complete: async () => { await gate; return answer('too late'); } }),
    });
    try {
      const { id } = await (await api(ui, 'POST', '/api/chat/conversations')).json() as ChatConversation;
      const pending = api(ui, 'POST', `/api/chat/conversations/${id}/messages`, { text: 'Slow question' });
      for (let attempt = 0; attempt < 100; attempt++) {
        const chat = await (await api(ui, 'GET', `/api/chat/conversations/${id}`)).json() as ChatConversation;
        if (chat.messages.length === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(await (await api(ui, 'POST', `/api/chat/conversations/${id}/cancel`)).json(), { cancelled: true });
      release();
      const streamed = events(await (await pending).text());
      const last = streamed.at(-1);
      if (last?.type !== 'error') throw new Error(`Expected an error event, got ${last?.type ?? 'nothing'}.`);
      assert.match(last.message ?? '', /stopped/i);
      const saved = await (await api(ui, 'GET', `/api/chat/conversations/${id}`)).json() as ChatConversation;
      assert.deepEqual(saved.messages.map((m) => m.role), ['user']);
    } finally {
      await ui.close();
    }
  });
});
