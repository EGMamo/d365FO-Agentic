import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { McpManager } from './manager.js';

function managerWith(client: object): McpManager {
  const manager = new McpManager();
  (manager as unknown as { clients: Map<string, object> }).clients.set('fake', client);
  return manager;
}
describe('MCP request cancellation', () => {
  it('forwards AbortSignal to tool discovery and tool requests', async () => {
    const controller = new AbortController();
    const client = {
      async listTools(_params: unknown, options: { signal: AbortSignal }) { assert.equal(options.signal, controller.signal); return { tools: [] }; },
      async callTool(_params: unknown, _schema: unknown, options: { signal: AbortSignal; timeout: number }) {
        assert.equal(options.signal, controller.signal); assert.equal(options.timeout, 123); return { content: [], isError: false };
      },
    };
    const manager = managerWith(client);
    await manager.listTools('fake', controller.signal);
    await manager.callTool('fake', 'test', {}, 123, controller.signal);
  });

  it('does not send an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    let reached = false;
    const manager = managerWith({ async callTool() { reached = true; return { content: [] }; } });
    await assert.rejects(manager.callTool('fake', 'test', {}, undefined, controller.signal), { name: 'AbortError' });
    assert.equal(reached, false);
  });

  it('rejects a late successful response after the run was cancelled', async () => {
    const controller = new AbortController();
    const manager = managerWith({ async callTool() { controller.abort(); return { content: [], isError: false }; } });
    await assert.rejects(manager.callTool('fake', 'test', {}, undefined, controller.signal), { name: 'AbortError' });
  });
});

describe('http server with a token provider', () => {
  it('sends a fresh bearer token on every request', async () => {
    const seen: Array<string | null> = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    let n = 0;
    try {
      const m = new McpManager();
      m.register({ name: 'x', transport: 'http', url: 'https://f.example/mcp', token: async () => `t${++n}` });
      await m.connect('x').catch(() => undefined);
      await m.connect('x').catch(() => undefined);
    } finally {
      globalThis.fetch = real;
    }
    assert.ok(seen.length >= 2, 'at least two requests were made');
    assert.equal(seen[0], 'Bearer t1');
    assert.equal(seen[1], 'Bearer t2');
  });
});
