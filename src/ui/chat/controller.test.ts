import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { ProfileError } from '../../profiles/store.js';
import { createChatController } from './controller.js';
import type { ChatService } from './service.js';
import type { ChatRepository } from './types.js';

const ID = '00000000-0000-4000-8000-000000000001';

describe('chat HTTP controller', () => {
  it('lets only one of two simultaneous sends to the same chat answer', async () => {
    let answering = 0;
    const service = {
      async send() {
        answering += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    } as unknown as ChatService;
    const send = (res: ServerResponse, status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const controller = createChatController({
      repository: {} as ChatRepository,
      service,
      send,
      // A slow body read is where both requests used to pass the "already answering" check.
      readJson: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { text: 'hello' };
      },
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://local');
      controller.handle(req, res, url, req.method ?? 'GET').catch((e: unknown) => {
        send(res, e instanceof ProfileError ? e.status : 500, { error: (e as Error).message });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat/conversations/${ID}/messages`;
      const post = () => fetch(url, { method: 'POST', body: '{"text":"hello"}' }).then(async (r) => ({ status: r.status, body: await r.text() }));
      const results = await Promise.all([post(), post()]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      assert.equal(answering, 1);
      // The slot is free again once the answer ends.
      assert.equal((await post()).status, 200);
      assert.equal(answering, 2);
    } finally {
      controller.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
