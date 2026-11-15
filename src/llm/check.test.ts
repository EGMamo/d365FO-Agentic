import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkModel } from './check.js';
import type { LlmCompleteResponse, LlmProvider } from './types.js';

const cfg = {} as never;

const provider = (complete: LlmProvider['complete']): LlmProvider => ({ name: 'fake', complete });
const ok = (text: string): LlmCompleteResponse => ({ text, toolCalls: [], stopReason: 'end_turn' });
const failing = (message: string) => () => provider(async () => {
  throw new Error(message);
});

describe('checkModel', () => {
  it('reports success with the model answer', async () => {
    const res = await checkModel(cfg, [], () => provider(async () => ok('OK')));
    assert.equal(res.ok, true);
    assert.match(res.detail, /"OK"/);
    assert.ok(!Number.isNaN(Date.parse(res.at)), 'timestamps the check');
  });

  it('masks secrets in both the answer and the failure detail', async () => {
    const secret = 'sk-ant-supersecretvalue';
    const answered = await checkModel(cfg, [secret], () => provider(async () => ok(`key ${secret} works`)));
    assert.equal(answered.ok, true);
    assert.ok(!answered.detail.includes(secret));
    assert.match(answered.detail, /\*\*\*/);

    const failed = await checkModel(cfg, [secret], failing(`400 bad request with key ${secret}\nsecond line ${secret}`));
    assert.ok(!failed.detail.includes(secret));
    assert.match(failed.detail, /\*\*\*/);
  });

  it('recognises a refused key and asks for a new one', async () => {
    for (const message of ['401 Unauthorized', 'authentication_error: invalid x-api-key', 'Error: forbidden']) {
      const res = await checkModel(cfg, [], failing(message));
      assert.equal(res.ok, false, message);
      assert.match(res.detail, /key was refused/, message);
    }
  });

  it('recognises a wrong model name or address', async () => {
    for (const message of ['404 Not Found', 'model claude-x does not exist', 'Error: model not found']) {
      const res = await checkModel(cfg, [], failing(message));
      assert.equal(res.ok, false, message);
      assert.match(res.detail, /did not accept the model name/, message);
    }
  });

  it('keeps any other failure to the first line of the message', async () => {
    const res = await checkModel(cfg, [], failing('socket hang up\nstack line\nanother line'));
    assert.equal(res.ok, false);
    assert.equal(res.detail, 'socket hang up');
  });

  it('says something even when the provider fails without a message', async () => {
    const res = await checkModel(cfg, [], failing(''));
    assert.equal(res.ok, false);
    assert.equal(res.detail, 'The model did not answer.');
  });
});
