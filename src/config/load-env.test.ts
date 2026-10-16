import assert from 'node:assert/strict';
import { test } from 'node:test';
import { environmentForChild } from './load-env.js';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiSettings, DEFAULT_MODEL } from '../profiles/ai.js';
import { ProfileStore } from '../profiles/store.js';

test('all profiles use the shared connection and blank model names get the default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'shared-config-'));
  await new ProfileStore(home).write('UAT', [{ key: 'ANTHROPIC_API_KEY', value: 'legacy-key' }, { key: 'LLM_MODEL', value: 'legacy-model' }], 'create');
  await new AiSettings(home).write([{ key: 'ANTHROPIC_API_KEY', value: 'shared-key' }, { key: 'LLM_MODEL', value: '' }]);
  const source = `import {loadConfig} from ${JSON.stringify(new URL('./index.js', import.meta.url).href)}; const c=loadConfig();console.log(JSON.stringify({model:c.LLM_MODEL,shared:c.ANTHROPIC_API_KEY==='shared-key'}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', env: { ...environmentForChild(), D365FO_AGENT_HOME: home, D365FO_PROFILE: 'UAT', ANTHROPIC_API_KEY: undefined, LLM_MODEL: undefined },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)!), { model: DEFAULT_MODEL, shared: true });
});

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
  const { ProfileStore } = await import('../profiles/store.js');
  const { selectProfile } = await import('./load-env.js');
  const home = await mkdtemp(join(tmpdir(), 'ids-'));
  const profiles = new ProfileStore(home);
  await profiles.write('Sandbox UAT', [], 'create');
  const pid = await profiles.idOf('Sandbox UAT');
  const env = { D365FO_AGENT_HOME: home } as NodeJS.ProcessEnv;
  assert.deepEqual(selectProfile(env, ['--profile', pid]), { name: 'Sandbox UAT', source: 'argv' });
  assert.deepEqual(selectProfile({ ...env, D365FO_PROFILE: pid }, []), { name: 'Sandbox UAT', source: 'env' });
  assert.equal(selectProfile(env, ['--profile', 'nope12345']).missing, 'nope12345');
  await profiles.rename('Sandbox UAT', 'Renamed');
  assert.equal(selectProfile(env, ['--profile', pid]).name, 'Renamed', 'the id still finds it after a rename');

});

test('upload picks the profile the saved run belongs to, unless --profile is given', async () => {
  const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ProfileStore } = await import('../profiles/store.js');
  const { selectProfile } = await import('./load-env.js');
  const home = await mkdtemp(join(tmpdir(), 'up-'));
  const profiles = new ProfileStore(home);
  await profiles.write('A', [], 'create');
  await profiles.write('B', [], 'create');
  await profiles.setActive('B');
  const dir = join(home, 'reports', 'x', 'history', '20260101-000000-1');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'results.json'), '[]');
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ profile: 'Old name', profileId: await profiles.idOf('A') }));
  const env = { D365FO_AGENT_HOME: home } as NodeJS.ProcessEnv;
  const argv = ['upload', '--input', join(dir, 'results.json')];
  assert.deepEqual(selectProfile(env, argv), { name: 'A', source: 'run' });
  assert.equal(selectProfile(env, [...argv, '--profile', 'B']).name, 'B');
  assert.equal(selectProfile(env, ['run']).name, 'B', 'other commands keep using the profile picked in the app');
});
