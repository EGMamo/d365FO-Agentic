import type { IncomingMessage, ServerResponse } from 'node:http';
import { ProfileError } from '../../profiles/store.js';
import type { ChatService } from './service.js';
import type { ChatEvent, ChatRepository } from './types.js';

interface ChatHttpDependencies {
  repository: ChatRepository;
  service: ChatService;
  send: (res: ServerResponse, status: number, body: unknown) => void;
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>;
}

/** Cookie-authenticated HTTP/SSE adapter for the app-owned Chat page. */
export function createChatController(deps: ChatHttpDependencies) {
  const active = new Map<string, AbortController>();

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
    const match = /^\/api\/chat\/conversations(?:\/([a-f0-9-]{36})(\/messages|\/cancel)?)?$/.exec(url.pathname);
    if (!match) return false;
    const [, id, action] = match;
    if (!id) {
      if (method === 'GET') return deps.send(res, 200, { conversations: await deps.repository.list() }), true;
      if (method === 'POST') {
        const body = await deps.readJson(req);
        return deps.send(res, 201, await deps.repository.create(typeof body.title === 'string' ? body.title : undefined)), true;
      }
      throw new ProfileError('Method not allowed.', 405);
    }
    if (!action && method === 'GET') return deps.send(res, 200, await deps.repository.get(id)), true;
    if (!action && method === 'PATCH') {
      const body = await deps.readJson(req);
      return deps.send(res, 200, await deps.repository.rename(id, String(body.title ?? ''))), true;
    }
    if (!action && method === 'DELETE') {
      active.get(id)?.abort();
      await deps.repository.delete(id);
      return deps.send(res, 200, { deleted: true }), true;
    }
    if (action === '/cancel' && method === 'POST') {
      const controller = active.get(id);
      controller?.abort();
      return deps.send(res, 200, { cancelled: Boolean(controller) }), true;
    }
    if (action !== '/messages' || method !== 'POST') throw new ProfileError('Method not allowed.', 405);
    if (active.has(id)) throw new ProfileError('This chat is already answering. Stop it or wait for the answer.', 409);
    // Claim the conversation before the first await: two sends racing through body parsing would otherwise both
    // run, interleaving their turns and breaking the tool_use/tool_result pairing the provider requires.
    const controller = new AbortController();
    active.set(id, controller);
    let body: Record<string, unknown>;
    try {
      body = await deps.readJson(req);
    } catch (e) {
      if (active.get(id) === controller) active.delete(id);
      throw e;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'close',
    });
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    const publish = (event: ChatEvent): void => {
      if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      await deps.service.send(id, String(body.text ?? ''), controller.signal, publish);
    } catch (e) {
      const aborted = controller.signal.aborted;
      publish({ type: 'error', message: aborted ? 'Answer stopped.' : (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 500) });
    } finally {
      if (active.get(id) === controller) active.delete(id);
      if (!res.writableEnded) res.end();
    }
    return true;
  }

  return {
    handle,
    close(): void {
      for (const controller of active.values()) controller.abort();
      active.clear();
    },
  };
}
