import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import dotenv from 'dotenv';
import { selectProfile } from '../config/load-env.js';
import { agentHome } from './paths.js';
import { formatValue, MASK, ProfileStore, serialize } from './store.js';

const fresh = async (): Promise<ProfileStore> => new ProfileStore(await mkdtemp(join(tmpdir(), 'prof-')));

describe('agentHome', () => {
  it('picks a per-user folder for each platform and honours the override', () => {
    // join: the path uses this computer's separator, so the test passes on Windows too.
    assert.equal(agentHome({}, 'darwin', '/Users/a'), join('/Users/a', 'Library', 'Application Support', 'd365fo-agent'));
    assert.equal(agentHome({ XDG_CONFIG_HOME: '/x' }, 'linux', '/home/a'), join('/x', 'd365fo-agent'));
    assert.equal(agentHome({}, 'linux', '/home/a'), join('/home/a', '.config', 'd365fo-agent'));
    assert.equal(agentHome({ D365FO_AGENT_HOME: '/custom' }, 'linux', '/home/a'), '/custom');
  });
});

describe('value quoting', () => {
  it('round-trips awkward values through the .env parser', () => {
    for (const v of ['plain', 'has space', 'M654#@!m', `it's`, `say "hi"`, 'back`tick', 'a$b', 'x=y']) {
      assert.equal(dotenv.parse(`K=${formatValue(v)}`).K, v, v);
    }
  });
});

describe('ProfileStore', () => {
  it('creates, lists, reads, updates and deletes profiles', async () => {
    const s = await fresh();
    await s.write('Sandbox', [{ key: 'D365_BASE_URL', value: 'https://x' }, { key: 'D365_PASSWORD', value: 'pw#1' }], 'create');
    await s.write('Other', [], 'create');
    assert.deepEqual((await s.list()).map((p) => p.name), ['Other', 'Sandbox']);
    assert.deepEqual(await s.read('sandbox'), [{ key: 'D365_BASE_URL', value: 'https://x' }, { key: 'D365_PASSWORD', value: MASK }]);
    await s.write('Sandbox', [{ key: 'D365_BASE_URL', value: 'https://y' }, { key: 'D365_PASSWORD', value: MASK }], 'replace');
    assert.equal((await s.read('Sandbox', true)).find((e) => e.key === 'D365_PASSWORD')?.value, 'pw#1', 'masked value keeps the stored secret');
    await s.write('Sandbox', [{ key: 'D365_BASE_URL', value: 'https://y' }], 'replace');
    assert.deepEqual((await s.read('Sandbox', true)).map((e) => e.key), ['D365_BASE_URL', 'PROFILE_ID'], 'omitting a secret removes it');
    await s.delete('Sandbox');
    assert.deepEqual((await s.list()).map((p) => p.name), ['Other']);
  });

  it('stores files readable only by the user and never leaks secrets when masked', async () => {
    const s = await fresh();
    await s.write('A', [{ key: 'ANTHROPIC_API_KEY', value: 'sk-secret' }], 'create');
    if (process.platform !== 'win32') assert.equal((await stat(s.fileFor('A'))).mode & 0o077, 0);
    assert.ok(!JSON.stringify(await s.read('A')).includes('sk-secret'));
    assert.match(await readFile(s.fileFor('A'), 'utf8'), /ANTHROPIC_API_KEY=sk-secret/);
  });

  it('rejects bad names, duplicate names (any letter case), bad keys and multi-line values', async () => {
    const s = await fresh();
    for (const bad of ['', '../evil', 'a/b', '.hidden', 'x'.repeat(61), 'trailing.']) {
      await assert.rejects(s.write(bad, [], 'create'), /Profile names/, bad);
    }
    await s.write('Prod', [], 'create');
    await assert.rejects(s.write('prod', [], 'create'), /already exists/);
    await assert.rejects(s.write('Prod', [{ key: '1BAD', value: '' }], 'replace'), /not a valid variable name/);
    await assert.rejects(s.write('Prod', [{ key: 'A', value: 'x\ny' }], 'replace'), /single line/);
    await assert.rejects(s.write('Prod', [{ key: 'A', value: '1' }, { key: 'A', value: '2' }], 'replace'), /twice/);
    await assert.rejects(s.write('Nope', [], 'replace'), /No profile/);
  });

  it('duplicates a profile and tracks the active one', async () => {
    const s = await fresh();
    await s.write('A', [{ key: 'D365_COMPANY', value: 'USMF' }], 'create');
    await s.duplicate('A', 'B');
    assert.equal((await s.read('B'))[0].value, 'USMF');
    assert.equal(await s.getActive(), undefined);
    await s.setActive('b');
    assert.equal(await s.getActive(), 'B');
    await s.delete('B');
    assert.equal(await s.getActive(), undefined, 'deleting the active profile clears it');
    await assert.rejects(s.setActive('Missing'), /No profile/);
  });

  it('gives each profile a permanent id that survives renaming, hidden from the UI', async () => {
    const s = await fresh();
    await s.write('A', [{ key: 'D365_COMPANY', value: 'USMF' }, { key: 'PROFILE_ID', value: 'hacked' }], 'create');
    const id = await s.idOf('A');
    assert.match(id, /^[a-z0-9]{8,32}$/);
    assert.notEqual(id, 'hacked');
    assert.deepEqual((await s.read('A')).map((e) => e.key), ['D365_COMPANY']);
    await s.write('A', [{ key: 'D365_COMPANY', value: 'DEMF' }], 'replace');
    assert.equal(await s.idOf('A'), id, 'saving keeps the id');
    await s.setActive('A');
    await s.rename('A', 'Sandbox UAT');
    assert.equal(await s.getActive(), 'Sandbox UAT');
    assert.equal(await s.idOf('Sandbox UAT'), id);
    assert.equal((await s.read('Sandbox UAT'))[0].value, 'DEMF');
    await s.duplicate('Sandbox UAT', 'Copy');
    assert.notEqual(await s.idOf('Copy'), id, 'a copy gets its own id');
    await assert.rejects(s.rename('Copy', 'sandbox uat'), /already exists/);
  });

  it('adds an id to a profile saved before ids existed', async () => {
    const s = await fresh();
    await writeFile(s.fileFor('Old'), 'D365_COMPANY=USMF\n').catch(async () => {
      await mkdir(join(s.home, 'profiles'), { recursive: true });
      await writeFile(s.fileFor('Old'), 'D365_COMPANY=USMF\n');
    });
    const id = await s.idOf('Old');
    assert.equal(await s.idOf('Old'), id);
    assert.equal((await s.read('Old'))[0].value, 'USMF');
  });

  it('serializes in a form dotenv reads back', () => {
    assert.deepEqual(dotenv.parse(serialize([{ key: 'A', value: '1' }, { key: 'B', value: 'two words' }])), { A: '1', B: 'two words' });
  });
});

describe('selectProfile', () => {
  it('prefers --profile, then D365FO_PROFILE, then the one chosen in the UI, else .env', async () => {
    const s = await fresh();
    await s.write('One', [], 'create');
    await s.write('Two', [], 'create');
    const env = { D365FO_AGENT_HOME: s.home } as NodeJS.ProcessEnv;
    assert.deepEqual(selectProfile(env, []), { source: 'none' });
    await s.setActive('One');
    assert.deepEqual(selectProfile(env, []), { name: 'One', source: 'ui' });
    assert.equal(selectProfile({ ...env, D365FO_PROFILE: 'Two' }, []).name, 'Two');
    assert.equal(selectProfile({ ...env, D365FO_PROFILE: 'Two' }, ['--profile', 'One']).name, 'One');
    assert.equal(selectProfile({ ...env, D365FO_PROFILE: 'none' }, []).name, undefined);
    assert.equal(selectProfile({ ...env, D365FO_PROFILE: 'Ghost' }, []).missing, 'Ghost');
    assert.equal(selectProfile({ ...env, D365FO_PROFILE: '../x' }, []).name, undefined);
  });
});
