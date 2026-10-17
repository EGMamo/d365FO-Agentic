import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it } from 'node:test';
import { AiSettings } from './ai.js';
import { MASK, ProfileStore } from './store.js';

it('backs up legacy configuration, prefers the chat connection, preserves profile IDs, and migrates once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'shared-ai-'));
  const profiles = new ProfileStore(home);
  await profiles.write(
    'UAT',
    [
      { key: 'AI_MODEL', value: 'profile123' },
      { key: 'REPORT_DIR', value: 'my-reports' },
    ],
    'create',
  );
  const id = await profiles.idOf('UAT');
  await profiles.setActive('UAT');
  await mkdir(join(home, 'models'));
  await writeFile(join(home, 'models', 'profile123.env'), 'LLM_PROVIDER=anthropic\nANTHROPIC_API_KEY=profile-key\n');
  await writeFile(
    join(home, 'models', 'chat12345.env'),
    'LLM_PROVIDER=anthropic\nANTHROPIC_API_KEY=chat-key\nLLM_MODEL=my-model\n',
  );
  const state = JSON.parse(await readFile(join(home, 'state.json'), 'utf8'));
  await writeFile(join(home, 'state.json'), JSON.stringify({ ...state, chatModel: 'chat12345' }));
  const ai = new AiSettings(home);
  await ai.migrate(profiles);
  assert.equal((await ai.read(true)).find((e) => e.key === 'ANTHROPIC_API_KEY')?.value, 'chat-key');
  assert.equal((await ai.read()).find((e) => e.key === 'ANTHROPIC_API_KEY')?.value, MASK);
  assert.equal(await profiles.idOf('UAT'), id);
  assert.equal((await profiles.read('UAT', true)).find((e) => e.key === 'REPORT_DIR')?.value, 'my-reports');
  const backup = join(home, 'backups', 'before-simplification-v1');
  assert.match(await readFile(join(backup, 'models', 'chat12345.env'), 'utf8'), /chat-key/);
  const originalProfile = await readFile(profiles.fileFor('UAT'), 'utf8');
  assert.equal(await readFile(join(backup, 'profiles', 'UAT.env'), 'utf8'), originalProfile);
  await ai.write([{ key: 'ANTHROPIC_API_KEY', value: 'replacement' }]);
  await ai.migrate(profiles);
  assert.equal((await ai.read(true)).find((e) => e.key === 'ANTHROPIC_API_KEY')?.value, 'replacement');
  await ai.write(await ai.read());
  assert.equal((await ai.read(true)).find((e) => e.key === 'ANTHROPIC_API_KEY')?.value, 'replacement');
});

it('falls back to the active profile and leaves unsupported connections in the backup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'shared-ai-'));
  const profiles = new ProfileStore(home);
  await profiles.write('UAT', [{ key: 'ANTHROPIC_API_KEY', value: 'old-profile-key' }], 'create');
  await profiles.setActive('UAT');
  await mkdir(join(home, 'models'));
  await writeFile(
    join(home, 'models', 'chat12345.env'),
    'LLM_PROVIDER=azure-openai\nAZURE_OPENAI_API_KEY=preserve-me\n',
  );
  await writeFile(join(home, 'state.json'), JSON.stringify({ active: 'UAT', chatModel: 'chat12345' }));
  const ai = new AiSettings(home);
  await ai.migrate(profiles);
  assert.equal((await ai.read(true)).find((e) => e.key === 'ANTHROPIC_API_KEY')?.value, 'old-profile-key');
  assert.match(
    await readFile(join(home, 'backups', 'before-simplification-v1', 'models', 'chat12345.env'), 'utf8'),
    /preserve-me/,
  );
  await assert.rejects(ai.write([{ key: 'LLM_PROVIDER', value: 'openai' }]), /uses Claude/);
  await assert.rejects(ai.write([{ key: 'ANTHROPIC_BASE_URL', value: 'not-an-address' }]), /HTTPS/);
});
