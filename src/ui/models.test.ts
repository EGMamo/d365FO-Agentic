import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LlmCompleteResponse, LlmProvider } from '../llm/types.js';
import { startUiServer, type RunningUi } from './server.js';

describe('AI models in the app', () => {
  let ui: RunningUi;
  let home = '';
  let cookie = '';
  let behaviour: (key: string) => LlmCompleteResponse | Error = () => ({ text: 'OK', toolCalls: [], stopReason: 'end_turn' });
  const call = (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        { host: '127.0.0.1', port: ui.port, method, path, headers: { host: `127.0.0.1:${ui.port}`, cookie, 'x-requested-with': 'd365fo-ui', ...(data ? { 'content-type': 'application/json' } : {}) } },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
        },
      );
      req.on('error', reject);
      req.end(data);
    });

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'models-ui-'));
    // A profile saved before AI models were shared still holds its own model settings.
    await mkdir(join(home, 'profiles'), { recursive: true });
    await writeFile(join(home, 'profiles', 'Old.env'), 'D365_COMPANY=USMF\nLLM_PROVIDER=anthropic\nANTHROPIC_API_KEY=sk-ant-oldkey123\nLLM_MODEL=claude-x\n');
    const provider = (cfg: { ANTHROPIC_API_KEY?: string }): LlmProvider => ({
      name: 'fake',
      complete: async () => {
        const r = behaviour(cfg.ANTHROPIC_API_KEY ?? '');
        if (r instanceof Error) throw r;
        return r;
      },
    });
    ui = await startUiServer({ home, port: 0, modelProvider: provider as never, childEnv: () => ({}) });
    cookie = await new Promise((resolve) => {
      request({ host: '127.0.0.1', port: ui.port, path: `/?token=${ui.token}`, headers: { host: `127.0.0.1:${ui.port}` } }, (res) => {
        res.resume();
        resolve(String(res.headers['set-cookie']).split(';')[0]);
      }).end();
    });
  });
  after(() => ui.close());

  it('moved the old profile model into a shared AI model at start', async () => {
    const state = (await call('GET', '/api/state')).body;
    assert.equal(state.models.length, 1);
    assert.equal(state.models[0].name, 'Claude · claude-x');
    assert.deepEqual(state.models[0].usedBy, { profiles: ['Old'], chat: true });
    assert.ok(!(await readFile(join(home, 'profiles', 'Old.env'), 'utf8')).includes('sk-ant-oldkey123'));
    const entries = (await call('GET', `/api/models/${state.models[0].id}`)).body.entries;
    assert.equal(entries.find((e: any) => e.key === 'ANTHROPIC_API_KEY').value, '••••••••', 'keys are masked');
  });

  it('creates, renames, tests and deletes AI models; one in use cannot be deleted', async () => {
    const made = await call('POST', '/api/models', { name: 'Azure', entries: [{ key: 'LLM_PROVIDER', value: 'anthropic' }, { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-good' }] });
    assert.equal(made.status, 201);
    const id = made.body.id;
    assert.equal((await call('POST', '/api/models', { name: 'azure', entries: [] })).status, 409);
    assert.equal((await call('PATCH', `/api/models/${id}`, { name: 'Azure OpenAI' })).status, 200);
    assert.equal((await call('POST', `/api/models/${id}/check`)).body.ok, true);
    behaviour = () => new Error('401 Unauthorized: invalid x-api-key sk-ant-good');
    const bad = (await call('POST', `/api/models/${id}/check`)).body;
    assert.equal(bad.ok, false);
    assert.match(bad.detail, /refused/);
    assert.ok(!bad.detail.includes('sk-ant-good'), 'the key is not echoed');
    assert.equal((await call('GET', '/api/state')).body.models.find((m: any) => m.id === id).check.ok, false, 'the last test is kept');
    behaviour = () => ({ text: 'OK', toolCalls: [], stopReason: 'end_turn' });

    assert.equal((await call('POST', '/api/chat-model', { id })).status, 200);
    assert.equal((await call('DELETE', `/api/models/${id}`)).status, 409, 'the chat uses it');
    const first = (await call('GET', '/api/models')).body.find((m: any) => m.id !== id).id;
    await call('POST', '/api/chat-model', { id: first });
    assert.equal((await call('DELETE', `/api/models/${id}`)).status, 200);
  });

  it('keeps the profile model choice on the profile and refuses a profile switch during nothing', async () => {
    const id = (await call('GET', '/api/models')).body[0].id;
    const profile = (await call('GET', '/api/profiles/Old')).body;
    assert.equal(profile.entries.find((e: any) => e.key === 'AI_MODEL').value, id);
    assert.ok(!profile.entries.some((e: any) => e.key === 'ANTHROPIC_API_KEY'));
    assert.equal((await call('POST', '/api/active', { name: 'Old' })).status, 200);
    assert.equal((await call('GET', '/api/state')).body.activeModel.id, id);
  });
});
