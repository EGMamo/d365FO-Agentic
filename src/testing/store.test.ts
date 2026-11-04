import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { TestCaseFileError, TestCaseFiles } from './store.js';

describe('test-case file containment', () => {
  let dir: string;
  let root: string;
  let outside: string;
  let files: TestCaseFiles;
  const draft = { id: 'SAFE', title: 'Safe case', steps: [{ action: 'Read a list' }] };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'case-paths-'));
    root = join(dir, 'workspace');
    outside = join(dir, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, 'private.json'), JSON.stringify({ ...draft, title: 'Outside marker' }));
    files = new TestCaseFiles(root);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('creates ordinary nested folders and supports editing, reading and deleting cases', async () => {
    assert.deepEqual(await files.list('new/nested'), []);
    const saved = await files.save('new/nested', draft);
    assert.equal((await files.read('new/nested', saved.file)).id, 'SAFE');
    await files.save('new/nested', { ...draft, title: 'Edited' }, saved.file);
    assert.equal((await files.list('new/nested'))[0].title, 'Edited');
    await files.delete('new/nested', saved.file);
    assert.deepEqual(await files.list('new/nested'), []);
  });

  it('rejects a linked directory for listing, reading, saving and deleting, before creating children', async () => {
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const denied = (e: unknown) => e instanceof TestCaseFileError && /Symbolic links/.test(e.message);
    await assert.rejects(files.list('linked'), denied);
    await assert.rejects(files.read('linked', 'private.json'), denied);
    await assert.rejects(files.save('linked', draft), denied);
    await assert.rejects(files.save('linked/new/deeper', draft), denied);
    await assert.rejects(files.delete('linked', 'private.json'), denied);
    await assert.rejects(lstat(join(outside, 'new')), { code: 'ENOENT' });
    assert.match(await readFile(join(outside, 'private.json'), 'utf8'), /Outside marker/);
  });

  it('does not read, replace or delete linked files, including a dangling link', async (t) => {
    // Windows file symlinks require Developer Mode or elevation; directory junctions above do not.
    try { await symlink(join(outside, 'private.json'), join(root, 'private.json'), 'file'); }
    catch (e) { if (process.platform === 'win32' && (e as NodeJS.ErrnoException).code === 'EPERM') return t.skip('Windows file symlinks require Developer Mode'); throw e; }
    await symlink(join(outside, 'missing.json'), join(root, 'safe.json'), 'file');
    assert.deepEqual(await files.list('.'), [], 'links are never listed as runnable cases');
    for (const name of ['private.json', 'safe.json']) {
      await assert.rejects(files.read('.', name), /Symbolic links/);
      await assert.rejects(files.save('.', draft, name), /Symbolic links/);
      await assert.rejects(files.delete('.', name), /Symbolic links/);
      assert.equal((await lstat(join(root, name))).isSymbolicLink(), true);
    }
    await assert.rejects(files.save('.', draft), /Symbolic links/);
    assert.match(await readFile(join(outside, 'private.json'), 'utf8'), /Outside marker/);
    await assert.rejects(lstat(join(outside, 'missing.json')), { code: 'ENOENT' });
  });

  it('rejects lexical escapes and never overwrites an existing case during creation', async () => {
    await assert.rejects(files.list('../outside'), /inside the project/);
    const saved = await files.save('.', draft);
    await assert.rejects(files.save('.', draft), /already/);
    assert.equal((await files.read('.', saved.file)).title, draft.title);
  });
});
