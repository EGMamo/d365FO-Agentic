import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProfileError } from '../../profiles/store.js';
import type { ChatConversation, ChatMessage, ChatRepository, ChatSummary } from './types.js';

const ID = /^[a-f0-9-]{36}$/;
const MAX_TITLE = 100;
const MAX_MESSAGES = 500;

const cleanTitle = (title: unknown, fallback = 'New chat'): string => {
  const value = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  return (value || fallback).slice(0, MAX_TITLE);
};

/**
 * Small, single-user conversation repository: one versioned JSON document per chat, written atomically.
 * The interface deliberately hides storage so SQLite or a remote implementation can be introduced later
 * without changing the chat service or HTTP layer.
 */
export class JsonChatRepository implements ChatRepository {
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(private readonly directory: string) {}

  async list(): Promise<ChatSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const chats = await Promise.all(files.filter((f) => /^[a-f0-9-]{36}\.json$/.test(f)).map(async (f) => {
      try {
        const chat = await this.readFile(f.slice(0, -5));
        return summary(chat);
      } catch {
        return undefined; // A damaged chat must not hide every other conversation.
      }
    }));
    return chats.filter((c): c is ChatSummary => Boolean(c)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Promise<ChatConversation> {
    return this.readFile(id);
  }

  async create(title?: string): Promise<ChatConversation> {
    const now = new Date().toISOString();
    const chat: ChatConversation = { version: 1, id: randomUUID(), title: cleanTitle(title), createdAt: now, updatedAt: now, messages: [] };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.write(chat);
    return chat;
  }

  rename(id: string, title: string): Promise<ChatConversation> {
    return this.mutate(id, (chat) => ({ ...chat, title: cleanTitle(title) }));
  }

  append(id: string, messages: Array<Omit<ChatMessage, 'id' | 'at'>>): Promise<ChatConversation> {
    if (!messages.length) return this.get(id);
    if (messages.some((m) => typeof m.content !== 'string' || m.content.length > 100_000)) throw new ProfileError('A chat message is too large.', 413);
    return this.mutate(id, (chat) => {
      if (chat.messages.length + messages.length > MAX_MESSAGES) throw new ProfileError(`A conversation cannot exceed ${MAX_MESSAGES} messages. Start a new chat.`, 409);
      const now = new Date().toISOString();
      const added = messages.map((m) => ({ ...m, id: randomUUID(), at: now }));
      const firstUser = !chat.messages.some((m) => m.role === 'user') && added.find((m) => m.role === 'user');
      return {
        ...chat,
        title: firstUser ? cleanTitle(firstUser.content, chat.title) : chat.title,
        updatedAt: now,
        messages: [...chat.messages, ...added],
      };
    });
  }

  async import(chat: ChatConversation): Promise<void> {
    assertId(chat.id);
    if (chat.version !== 1 || !Array.isArray(chat.messages)) throw new ProfileError('This chat uses an unsupported format.', 409);
    await this.write(chat);
  }

  async delete(id: string): Promise<void> {
    assertId(id);
    try {
      await unlink(join(this.directory, `${id}.json`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ProfileError('No such chat.', 404);
      throw e;
    }
  }

  /** Serializes writes per conversation while allowing unrelated chats to proceed independently. */
  private mutate(id: string, change: (chat: ChatConversation) => ChatConversation): Promise<ChatConversation> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const chat = change(await this.readFile(id));
      await this.write(chat);
      return chat;
    });
    this.writes.set(id, next);
    void next.finally(() => {
      if (this.writes.get(id) === next) this.writes.delete(id);
    }).catch(() => undefined);
    return next;
  }

  private async readFile(id: string): Promise<ChatConversation> {
    assertId(id);
    let parsed: ChatConversation;
    try {
      parsed = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')) as ChatConversation;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ProfileError('No such chat.', 404);
      throw new ProfileError('This chat could not be read. Its JSON file may be damaged.', 409);
    }
    if (parsed.version !== 1 || parsed.id !== id || !Array.isArray(parsed.messages)) throw new ProfileError('This chat uses an unsupported format.', 409);
    return { ...parsed, title: cleanTitle(parsed.title) };
  }

  private async write(chat: ChatConversation): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${chat.id}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(chat, null, 2), { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

function summary(chat: ChatConversation): ChatSummary {
  return { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, messageCount: chat.messages.length, ...(chat.importedFrom ? { importedFrom: chat.importedFrom } : {}) };
}

function assertId(id: string): void {
  if (!ID.test(id)) throw new ProfileError('No such chat.', 404);
}
