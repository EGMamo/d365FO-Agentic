import assert from 'node:assert/strict';
import { test } from 'node:test';
import { environmentForChild } from './load-env.js';

test('environmentForChild drops what was read from a settings file and keeps the real environment', () => {
  const env = { PATH: '/bin', D365_BASE_URL: 'https://from-file.example', LLM_PROVIDER: 'openai', HOME: '/home/u' };
  assert.deepEqual(environmentForChild(env, ['D365_BASE_URL', 'LLM_PROVIDER', 'NOT_SET']), { PATH: '/bin', HOME: '/home/u' });
  assert.equal(env.D365_BASE_URL, 'https://from-file.example');
  assert.deepEqual(environmentForChild(env, []), env);
});

test('a profile can be named by its permanent id, and an AI model by id or name', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ModelStore } = await import('../profiles/models.js');
  const { ProfileStore } = await import('../profiles/store.js');
  const { selectModel, selectProfile } = await import('./load-env.js');
  const home = await mkdtemp(join(tmpdir(), 'ids-'));
  const profiles = new ProfileStore(home);
  const models = new ModelStore(home);
  await profiles.write('Sandbox UAT', [], 'create');
  const pid = await profiles.idOf('Sandbox UAT');
  const mid = await models.write(undefined, 'Claude gateway', [{ key: 'LLM_PROVIDER', value: 'anthropic' }]);
  const env = { D365FO_AGENT_HOME: home } as NodeJS.ProcessEnv;
  assert.deepEqual(selectProfile(env, ['--profile', pid]), { name: 'Sandbox UAT', source: 'argv' });
  assert.deepEqual(selectProfile({ ...env, D365FO_PROFILE: pid }, []), { name: 'Sandbox UAT', source: 'env' });
  assert.equal(selectProfile(env, ['--profile', 'nope12345']).missing, 'nope12345');
  await profiles.rename('Sandbox UAT', 'Renamed');
  assert.equal(selectProfile(env, ['--profile', pid]).name, 'Renamed', 'the id still finds it after a rename');

  assert.deepEqual(selectModel(env, [], undefined), { source: 'none' });
  assert.deepEqual(selectModel(env, [], mid), { id: mid, name: 'Claude gateway', source: 'profile' });
  assert.equal(selectModel(env, ['--model', 'CLAUDE gateway'], 'other')?.source, 'argv');
  assert.equal(selectModel(env, ['--model=' + mid], undefined).id, mid);
  assert.equal(selectModel({ ...env, D365FO_MODEL: 'Claude gateway' }, [], mid).source, 'env');
  assert.equal(selectModel(env, ['--model', 'ghost'], mid).missing, 'ghost');
});
