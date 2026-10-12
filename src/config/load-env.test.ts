import assert from 'node:assert/strict';
import { test } from 'node:test';
import { environmentForChild } from './load-env.js';

test('environmentForChild drops what was read from a settings file and keeps the real environment', () => {
  const env = { PATH: '/bin', D365_BASE_URL: 'https://from-file.example', LLM_PROVIDER: 'openai', HOME: '/home/u' };
  assert.deepEqual(environmentForChild(env, ['D365_BASE_URL', 'LLM_PROVIDER', 'NOT_SET']), { PATH: '/bin', HOME: '/home/u' });
  assert.equal(env.D365_BASE_URL, 'https://from-file.example');
  assert.deepEqual(environmentForChild(env, []), env);
});
