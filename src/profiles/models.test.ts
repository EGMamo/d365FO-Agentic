import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { migrateProfileModels, ModelStore } from './models.js';
import { MASK, ProfileStore } from './store.js';

const fresh = async () => {
  const home = await mkdtemp(join(tmpdir(), 'models-'));
  return { home, models: new ModelStore(home), profiles: new ProfileStore(home) };
};

describe('ModelStore', () => {
  it('keeps setups under a permanent id, masks keys and keeps a key sent back as the mask', async () => {
    const { models } = await fresh();
    const id = await models.write(undefined, 'Claude direct', [{ key: 'LLM_PROVIDER', value: 'anthropic' }, { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-secret' }, { key: 'LLM_MODEL', value: 'claude-x' }]);
    assert.match(id, /^[a-z0-9]{8,32}$/);
    assert.deepEqual(await models.read(id), [{ key: 'MODEL_NAME', value: 'Claude direct' }, { key: 'LLM_PROVIDER', value: 'anthropic' }, { key: 'ANTHROPIC_API_KEY', value: MASK }, { key: 'LLM_MODEL', value: 'claude-x' }]);
    await models.write(id, 'Claude gateway', [{ key: 'LLM_PROVIDER', value: 'anthropic' }, { key: 'ANTHROPIC_API_KEY', value: MASK }, { key: 'LLM_MODEL', value: 'claude-y' }]);
    assert.equal((await models.read(id, true)).find((e) => e.key === 'ANTHROPIC_API_KEY')?.value, 'sk-ant-secret');
    const [one] = await models.list();
    assert.deepEqual([one.id, one.name, one.provider, one.model], [id, 'Claude gateway', 'anthropic', 'claude-y']);
    assert.equal((await models.find('claude GATEWAY'))?.id, id);
    assert.equal((await models.find(id))?.name, 'Claude gateway');
    await assert.rejects(models.write(undefined, 'claude gateway', []), /already exists/);
  });

  it('refuses to delete a setup in use, and the chat can use one', async () => {
    const { models, profiles } = await fresh();
    const id = await models.write(undefined, 'Azure', [{ key: 'LLM_PROVIDER', value: 'azure-openai' }]);
    await profiles.write('Sandbox', [{ key: 'AI_MODEL', value: id }], 'create');
    await assert.rejects(models.delete(id, profiles), /profile Sandbox/);
    await profiles.write('Sandbox', [], 'replace');
    assert.equal(await models.getChat(), id, 'the only setup is the chat model until one is chosen');
    await assert.rejects(models.delete(id, profiles), /the chat/);
    const other = await models.write(undefined, 'Other', []);
    await models.setChat(other);
    await models.delete(id, profiles);
    assert.deepEqual((await models.list()).map((m) => m.id), [other]);
    await assert.rejects(models.setChat('aaaaaaaa'), /No AI model/);
  });

  it('does not lose the active profile when the chat model is saved, and the other way round', async () => {
    const { models, profiles } = await fresh();
    await profiles.write('A', [], 'create');
    await profiles.setActive('A');
    const id = await models.write(undefined, 'M', []);
    await models.setChat(id);
    assert.equal(await profiles.getActive(), 'A');
    await profiles.setActive('A');
    assert.equal(await models.getChat(), id);
  });
});

describe('migrating profile models to shared setups', () => {
  it('turns each profile model into a setup, shares identical ones and points the profile to it', async () => {
    const { models, profiles, home } = await fresh();
    const same = [{ key: 'LLM_PROVIDER', value: 'anthropic' }, { key: 'ANTHROPIC_API_KEY', value: 'sk-1' }, { key: 'LLM_MODEL', value: 'claude-x' }];
    await profiles.write('Sandbox', [{ key: 'D365_COMPANY', value: 'USMF' }, ...same], 'create');
    await profiles.write('Dev', [...same], 'create');
    await profiles.write('Local', [{ key: 'LLM_PROVIDER', value: 'openai-compatible' }, { key: 'OPENAI_COMPATIBLE_MODEL', value: 'llama3' }], 'create');
    await profiles.write('Bare', [{ key: 'D365_COMPANY', value: 'DEMF' }], 'create');
    assert.equal(await migrateProfileModels(profiles, models), 3);
    const list = await models.list();
    assert.equal(list.length, 2, 'Sandbox and Dev share one setup');
    const sandbox = await profiles.read('Sandbox', true);
    assert.deepEqual(sandbox.map((e) => e.key).sort(), ['AI_MODEL', 'D365_COMPANY', 'PROFILE_ID']);
    assert.equal(sandbox.find((e) => e.key === 'AI_MODEL')?.value, (await profiles.read('Dev', true)).find((e) => e.key === 'AI_MODEL')?.value);
    assert.ok(!(await readFile(profiles.fileFor('Sandbox'), 'utf8')).includes('sk-1'), 'the key moved out of the profile');
    assert.equal((await profiles.read('Bare', true)).some((e) => e.key === 'AI_MODEL'), false);
    assert.ok(list.some((m) => m.name === 'Claude · claude-x'));
    assert.equal(await migrateProfileModels(profiles, models), 0, 'a second pass changes nothing');
    assert.ok(home);
  });
});
