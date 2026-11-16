import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { importOpenWebUiChats } from './legacy.js';
import { JsonChatRepository } from './store.js';

const CHAT_SCHEMA = 'CREATE TABLE chat (id VARCHAR PRIMARY KEY, title TEXT, created_at BIGINT, updated_at BIGINT, archived BOOLEAN, chat JSON)';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'chat-legacy-'));
  const data = join(root, 'legacy');
  const state = join(root, 'state.json');
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'webui.db'), '');
  return { root, data, state };
}

describe('Open WebUI conversation import', () => {
  it('imports readable history once and resumes an interrupted migration without duplicates', async () => {
    const { root, data, state } = await fixture();
    const old = { id: 'chat-1', title: 'UAT check', created_at: 1_700_000_000, updated_at: 1_700_000_100, chat: JSON.stringify({ messages: [
      { id: 'm1', role: 'user', content: 'Check setup', timestamp: 1_700_000_010 },
      { id: 'm2', role: 'assistant', content: 'It looks healthy.', timestamp: 1_700_000_020 },
      { id: 'm3', role: 'tool', content: 'internal trace', timestamp: 1_700_000_030 },
    ] }) };
    const branched = { id: 'chat-2', title: 'History branch', created_at: 1_700_000_000, updated_at: 1_700_000_200, chat: JSON.stringify({ history: {
      currentId: 'last', messages: {
        first: { id: 'first', parentId: null, role: 'user', content: 'First question' },
        other: { id: 'other', parentId: 'first', role: 'assistant', content: 'Not the current branch' },
        last: { id: 'last', parentId: 'first', role: 'assistant', content: 'Current answer' },
      },
    } }) };
    const repository = new JsonChatRepository(join(root, 'chats'));
    const rows = [old, branched];
    const first = await importOpenWebUiChats(repository, data, state, async () => rows);
    assert.deepEqual(first, { imported: 2, skipped: 0, unchanged: false });
    const chats = await repository.list();
    assert.equal(chats.length, 2);
    assert.deepEqual(chats.map((c) => c.importedFrom).sort(), ['openwebui:chat-1', 'openwebui:chat-2']);
    assert.deepEqual((await repository.get(chats[0].id)).messages.every((m) => m.role !== 'tool'), true);
    assert.deepEqual((await repository.get(chats.find((c) => c.importedFrom === 'openwebui:chat-2')!.id)).messages.map((m) => m.content), ['First question', 'Current answer']);

    assert.deepEqual(await importOpenWebUiChats(repository, data, state, async () => rows), { imported: 0, skipped: 0, unchanged: true });
    await rm(state);
    assert.deepEqual(await importOpenWebUiChats(repository, data, state, async () => rows), { imported: 0, skipped: 2, unchanged: false });
    assert.equal((await repository.list()).length, 2);
  });

  it('reads the actual SQLite schema used by Open WebUI', async () => {
    const { root, state } = await fixture();
    const source = join(root, 'real-data', 'webui.db');
    await mkdir(join(root, 'real-data'), { recursive: true });
    const db = new DatabaseSync(source);
    db.exec(CHAT_SCHEMA);
    db.prepare('INSERT INTO chat VALUES (?, ?, ?, ?, ?, ?)').run('real-id', 'Real database', 1_700_000_000, 1_700_000_100, 0, JSON.stringify({ messages: [{ role: 'user', content: 'From SQLite' }] }));
    db.close();
    const repository = new JsonChatRepository(join(root, 'new-chats'));
    assert.deepEqual(await importOpenWebUiChats(repository, join(root, 'real-data'), state), { imported: 1, skipped: 0, unchanged: false });
    assert.equal((await repository.list())[0].title, 'Real database');
  });

  it('reads committed conversations that are still only in the SQLite WAL', async () => {
    const { root, state } = await fixture();
    const data = join(root, 'wal-data');
    await mkdir(data, { recursive: true });
    const writer = new DatabaseSync(join(data, 'webui.db'));
    writer.exec('PRAGMA journal_mode = WAL');
    writer.exec(CHAT_SCHEMA);
    writer.prepare('INSERT INTO chat VALUES (?, ?, ?, ?, ?, ?)').run('wal-id', 'From WAL', 1_700_000_000, 1_700_000_100, 0, JSON.stringify({ messages: [{ role: 'user', content: 'Uncheckpointed' }] }));
    try {
      const repository = new JsonChatRepository(join(root, 'wal-chats'));
      assert.deepEqual(await importOpenWebUiChats(repository, data, state), { imported: 1, skipped: 0, unchanged: false });
      assert.equal((await repository.list())[0].title, 'From WAL');
      writer.prepare('INSERT INTO chat VALUES (?, ?, ?, ?, ?, ?)').run('wal-id-2', 'Later WAL row', 1_700_000_200, 1_700_000_300, 0, JSON.stringify({ messages: [{ role: 'user', content: 'Added later' }] }));
      assert.deepEqual(await importOpenWebUiChats(repository, data, state), { imported: 1, skipped: 1, unchanged: false });
      assert.equal((await repository.list()).length, 2);
    } finally {
      writer.close();
    }
  });
});
