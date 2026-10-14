import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { HistoryIndex, RunHistory } from './history.js';

describe('run history across profiles', () => {
  it('lists the runs of every report folder together and finds each by id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hist-'));
    const a = join(root, 'a');
    const b = join(root, 'b');
    const ha = new RunHistory(async () => a);
    const hb = new RunHistory(async () => b);
    await writeFile(join(root, 'x'), '');
    const one = await ha.record({ status: 'passed', args: ['run'], profile: 'A', profileId: 'aaaa', model: 'M1', mode: 'live', origin: 'cli', startedAt: '2026-10-14T10:00:00.000Z' }, 1);
    const two = await hb.record({ status: 'failed', args: ['run'], profile: 'B', profileId: 'bbbb', startedAt: '2026-10-14T11:00:00.000Z' }, 2);
    const index = new HistoryIndex(async () => [a, b, a, join(root, 'missing')]);
    assert.deepEqual((await index.list()).map((r) => r.id), [two.id, one.id], 'newest first, duplicates folders counted once');
    assert.equal((await index.meta(one.id))?.profile, 'A');
    assert.equal((await index.meta(one.id))?.model, 'M1');
    await index.update(two.id, { upload: { at: 'now', runId: 5 } });
    assert.equal((await hb.meta(two.id))?.upload?.runId, 5, 'the update lands in the folder that holds the run');
    assert.equal(await index.delete(one.id), true);
    assert.equal((await ha.list()).length, 0);
    assert.equal(await index.delete('20260101-000000-9'), false);
  });
});
