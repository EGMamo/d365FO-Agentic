import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { normalizeOpenAiBaseUrl, OpenAiCompatibleProvider, toWireMessages } from './openai.js';
import { createLlmProvider } from './index.js';
import { checkAnthropicEndpoint } from './endpoint.js';
import { toUnavailable } from './errors.js';
import { parseConfig, validateForRun } from '../config/index.js';
import type { LlmMessage } from './types.js';

type Handler = (req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse) => void;

describe('OpenAI-compatible gateway adapter', () => {
  let base = '';
  let handler: Handler = () => undefined;
  const seen: Array<{ path: string; auth?: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ path: req.url ?? '', auth: req.headers.authorization, body });
      handler(req, body, res);
    });
  });
  const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(value));
  };
  const llm = (over: Partial<ConstructorParameters<typeof OpenAiCompatibleProvider>[0]> = {}) =>
    new OpenAiCompatibleProvider({ apiKey: 'gw-key', baseURL: base, model: 'vertex_ai.anthropic.claude-sonnet-4', maxTokens: 100, temperature: 0, retryBaseMs: 1, ...over });

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('normalizes the pasted gateway address', () => {
    assert.equal(normalizeOpenAiBaseUrl('https://gw.example'), 'https://gw.example/v1');
    assert.equal(normalizeOpenAiBaseUrl('https://gw.example/v1/'), 'https://gw.example/v1');
    assert.equal(normalizeOpenAiBaseUrl('https://gw.example/v1/chat/completions'), 'https://gw.example/v1');
    assert.equal(normalizeOpenAiBaseUrl('https://gw.example/openai/v2'), 'https://gw.example/openai/v2');
    assert.equal(normalizeOpenAiBaseUrl(' '), undefined);
  });

  it('maps tools, tool calls and tool results onto chat completions', async () => {
    handler = (_req, _body, res) => json(res, 200, {
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'list_profiles', arguments: '{"all":true}' } }] } }],
      usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } },
    });
    const messages: LlmMessage[] = [
      { role: 'user', content: 'Which environments?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_run', arguments: { tail: 5 } }] },
      { role: 'tool', content: '{"run":null}', toolCallId: 'call_1', toolName: 'get_run' },
    ];
    const answer = await llm().complete({
      system: 'Be brief.',
      messages,
      tools: [{ name: 'list_profiles', description: 'List', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {} } }],
    });
    const sent = seen.at(-1)!;
    assert.equal(sent.path, '/v1/chat/completions');
    assert.equal(sent.auth, 'Bearer gw-key');
    assert.equal(sent.body.model, 'vertex_ai.anthropic.claude-sonnet-4');
    assert.deepEqual(sent.body.messages, [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Which environments?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_run', arguments: '{"tail":5}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"run":null}' },
    ]);
    assert.deepEqual(sent.body.tools, [{ type: 'function', function: { name: 'list_profiles', description: 'List', parameters: { type: 'object', properties: {} } } }]);
    assert.deepEqual(answer, {
      text: '',
      toolCalls: [{ id: 'call_9', name: 'list_profiles', arguments: { all: true } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 8 },
    });
  });

  it('reads text answers, content parts and malformed arguments', async () => {
    handler = (_req, _body, res) => json(res, 200, { choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: 'O' }, { type: 'text', text: 'K' }] } }] });
    const text = await llm().complete({ messages: [{ role: 'user', content: 'Say OK' }] });
    assert.equal(text.text, 'OK');
    assert.equal(text.stopReason, 'end_turn');
    assert.equal(seen.at(-1)!.body.tools, undefined, 'no empty tools array is sent');

    handler = (_req, _body, res) => json(res, 200, { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'get_run', arguments: '{oops' } }] } }] });
    const call = await llm().complete({ messages: [{ role: 'user', content: 'x' }] });
    assert.deepEqual(call.toolCalls, [{ id: 'call_0', name: 'get_run', arguments: {} }]);
  });

  it('reports HTTP failures with their status, so auth and outages are classified', async () => {
    handler = (_req, _body, res) => json(res, 401, { error: { message: 'Invalid API key' } });
    await assert.rejects(llm().complete({ messages: [{ role: 'user', content: 'x' }] }), (e: Error & { status?: number }) => {
      assert.equal(e.status, 401);
      assert.match(e.message, /HTTP 401 from the gateway: Invalid API key/);
      assert.equal(toUnavailable(e)?.status, 401);
      return true;
    });
  });

  it('retries a transient 503, then succeeds', async () => {
    let calls = 0;
    handler = (_req, _body, res) => {
      calls += 1;
      if (calls === 1) json(res, 503, { error: { message: 'busy' } });
      else json(res, 200, { choices: [{ finish_reason: 'stop', message: { content: 'done' } }] });
    };
    assert.equal((await llm().complete({ messages: [{ role: 'user', content: 'x' }] })).text, 'done');
    assert.equal(calls, 2);
  });

  it('cancels an in-flight request when the run or chat stops', async () => {
    handler = () => undefined; // never answers
    const controller = new AbortController();
    const pending = llm({ timeoutMs: 10_000 }).complete({ messages: [{ role: 'user', content: 'x' }], signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    await assert.rejects(pending);
    assert.ok(Date.now() - started < 2000, 'the stop does not wait for the gateway timeout');
  });

  it('is chosen by LLM_API_FORMAT=openai and needs the gateway address', () => {
    const env = { D365_BASE_URL: 'https://x.sandbox.operations.dynamics.com', ANTHROPIC_API_KEY: 'k', LLM_API_FORMAT: 'openai' };
    assert.equal(createLlmProvider(parseConfig({ ...env, ANTHROPIC_BASE_URL: 'https://gw.example' })).name, 'openai-compatible');
    assert.throws(() => createLlmProvider(parseConfig(env)), /gateway address/);
    assert.ok(validateForRun(parseConfig(env)).some((i) => /LLM_API_FORMAT=openai needs/.test(i)));
    assert.equal(createLlmProvider(parseConfig({ ...env, LLM_API_FORMAT: '' })).name, 'anthropic');
    assert.throws(() => parseConfig({ ...env, LLM_API_FORMAT: 'gemini' }));
  });

  it('lets doctor list the gateway models with a bearer token', async () => {
    handler = (_req, _body, res) => json(res, 200, { data: [{ id: 'vertex_ai.anthropic.claude-sonnet-4' }] });
    const check = await checkAnthropicEndpoint(`${base}/v1`, { apiKey: 'gw-key' }, 2000, fetch, 'openai');
    assert.equal(seen.at(-1)!.path, '/v1/models');
    assert.equal(seen.at(-1)!.auth, 'Bearer gw-key');
    assert.deepEqual(check.models, ['vertex_ai.anthropic.claude-sonnet-4']);
  });

  it('keeps the request system prompt authoritative', () => {
    assert.deepEqual(toWireMessages({ system: 's', messages: [{ role: 'system', content: 'ignored' }, { role: 'user', content: 'u' }] }), [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
  });
});
