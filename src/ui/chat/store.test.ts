import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { JsonChatRepository } from './store.js';

const temp = () => mkdtemp(join(tmpdir(), 'd365fo-chats-'));

describe('JsonChatRepository', () => {
  it('persists complete conversations with generated ids, titles and model tool context', async () => {
    const home = await temp();
    const repo = new JsonChatRepository(home);
    const empty = await repo.create();
    assert.equal(empty.title, 'New chat');
    assert.equal((await repo.list()).length, 1);

    const chat = await repo.append(empty.id, [
      { role: 'user', content: 'Check UAT setup' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'check_setup', arguments: {} }] },
      { role: 'tool', content: '{"exitCode":0}', toolCallId: 'call-1', toolName: 'check_setup' },
    ]);
    assert.equal(chat.title, 'Check UAT setup');
    const reloaded = await new JsonChatRepository(home).get(empty.id);
    assert.deepEqual(reloaded.messages, chat.messages);
    assert.equal((await repo.list())[0].messageCount, 3);
    assert.equal((await repo.rename(empty.id, ' UAT diagnostics ')).title, 'UAT diagnostics');
    await repo.delete(empty.id);
    assert.deepEqual(await repo.list(), []);
  });

  it('serializes appends so simultaneous answers cannot overwrite each other', async () => {
    const repo = new JsonChatRepository(await temp());
    const { id } = await repo.create();
    await Promise.all([
      repo.append(id, [{ role: 'user', content: 'First' }]),
      repo.append(id, [{ role: 'assistant', content: 'Second' }]),
      repo.append(id, [{ role: 'user', content: 'Third' }]),
    ]);
    assert.deepEqual((await repo.get(id)).messages.map((m) => m.content), ['First', 'Second', 'Third']);
  });

  it('keeps readable chats listed when another file is damaged', async () => {
    const home = await temp();
    const repo = new JsonChatRepository(home);
    const { id } = await repo.create('Readable');
    await writeFile(join(home, '00000000-0000-4000-8000-000000000000.json'), '{broken');
    assert.deepEqual((await repo.list()).map((c) => c.id), [id]);
    assert.equal(JSON.parse(await readFile(join(home, `${id}.json`), 'utf8')).title, 'Readable');
  });
});
