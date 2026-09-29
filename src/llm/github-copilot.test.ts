import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  CopilotSessionAuth,
  createGitHubCopilotProvider,
  loginWithDeviceFlow,
  resolveGitHubToken,
  saveGitHubToken,
} from './github-copilot.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';

const NO_RETRY = { timeoutMs: 5000, maxRetries: 0, retryBaseMs: 1 };

interface Call {
  url: string;
  init: RequestInit;
}

/** Replaces global fetch with a router keyed by URL prefix; records every call. */
function stubFetch(routes: Record<string, (call: Call, n: number) => Response>): Call[] {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const call = { url, init };
    calls.push(call);
    const prefix = Object.keys(routes).find((p) => url.startsWith(p));
    assert.ok(prefix, `unexpected request to ${url}`);
    const n = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, n);
    return routes[prefix](call, n);
  });
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sessionToken = (token: string, expiresInSec = 1800, api = 'https://api.individual.githubcopilot.com') =>
  json({ token, expires_at: Math.floor(Date.now() / 1000) + expiresInSec, endpoints: { api } });

const chatReply = (content = 'hi') =>
  json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } });

const headersOf = (call: Call) => call.init.headers as Record<string, string>;

const TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const CHAT_URL = 'https://api.individual.githubcopilot.com/chat/completions';

function makeProvider() {
  return createGitHubCopilotProvider({
    githubToken: 'gho_test',
    model: 'gpt-4.1',
    maxTokens: 100,
    temperature: 0.1,
    http: NO_RETRY,
  });
}

beforeEach(() => mock.restoreAll());
afterEach(() => mock.restoreAll());

describe('github-copilot provider', () => {
  it('exchanges the GitHub token, then calls the account-specific chat endpoint with editor headers', async () => {
    const calls = stubFetch({
      [TOKEN_URL]: () => sessionToken('tid=abc'),
      [CHAT_URL]: () =>
        json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'c1', function: { name: 'report_step', arguments: '{"index":1}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
    });

    const res = await makeProvider().complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'report_step', description: 'd', inputSchema: { type: 'object' } }],
    });

    assert.equal(calls.length, 2);
    assert.equal(headersOf(calls[0]).authorization, 'token gho_test');
    assert.equal(headersOf(calls[1]).authorization, 'Bearer tid=abc');
    assert.equal(headersOf(calls[1])['copilot-integration-id'], 'vscode-chat');
    assert.ok(headersOf(calls[1])['editor-version']);

    const body = JSON.parse(String(calls[1].init.body));
    assert.equal(body.model, 'gpt-4.1');
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.tools[0].function.name, 'report_step');

    assert.equal(res.stopReason, 'tool_use');
    assert.deepEqual(res.toolCalls, [{ id: 'c1', name: 'report_step', arguments: { index: 1 } }]);
    assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 5 });
  });

  it('reuses the cached session token across requests', async () => {
    const calls = stubFetch({ [TOKEN_URL]: () => sessionToken('tid=1'), [CHAT_URL]: () => chatReply() });
    const provider = makeProvider();
    await provider.complete({ messages: [{ role: 'user', content: 'a' }] });
    await provider.complete({ messages: [{ role: 'user', content: 'b' }] });
    assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1);
    assert.equal(calls.filter((c) => c.url === CHAT_URL).length, 2);
  });

  it('re-exchanges when the session token is within the refresh window', async () => {
    const calls = stubFetch({
      // 30s left is inside the 60s refresh skew, so it must not be reused.
      [TOKEN_URL]: (_c, n) => sessionToken(`tid=${n}`, 30),
      [CHAT_URL]: () => chatReply(),
    });
    const provider = makeProvider();
    await provider.complete({ messages: [{ role: 'user', content: 'a' }] });
    await provider.complete({ messages: [{ role: 'user', content: 'b' }] });
    const chats = calls.filter((c) => c.url === CHAT_URL);
    assert.equal(headersOf(chats[0]).authorization, 'Bearer tid=1');
    assert.equal(headersOf(chats[1]).authorization, 'Bearer tid=2');
  });

  it('drops the session and retries once when the chat endpoint answers 401', async () => {
    const calls = stubFetch({
      [TOKEN_URL]: (_c, n) => sessionToken(`tid=${n}`),
      [CHAT_URL]: (_c, n) => (n === 1 ? json({ error: 'expired' }, 401) : chatReply('ok')),
    });
    const res = await makeProvider().complete({ messages: [{ role: 'user', content: 'a' }] });
    assert.equal(res.text, 'ok');
    const chats = calls.filter((c) => c.url === CHAT_URL);
    assert.equal(chats.length, 2);
    assert.equal(headersOf(chats[1]).authorization, 'Bearer tid=2');
  });

  it('gives up after a single 401 retry', async () => {
    const calls = stubFetch({
      [TOKEN_URL]: (_c, n) => sessionToken(`tid=${n}`),
      [CHAT_URL]: () => json({ error: 'nope' }, 401),
    });
    await assert.rejects(makeProvider().complete({ messages: [{ role: 'user', content: 'a' }] }), /github-copilot error 401/);
    assert.equal(calls.filter((c) => c.url === CHAT_URL).length, 2);
  });

  it('falls back to the default API host when the exchange returns no endpoints', async () => {
    const calls = stubFetch({
      [TOKEN_URL]: () => json({ token: 'tid=1', expires_at: Math.floor(Date.now() / 1000) + 1800 }),
      'https://api.githubcopilot.com/chat/completions': () => chatReply(),
    });
    await makeProvider().complete({ messages: [{ role: 'user', content: 'a' }] });
    assert.equal(calls[1].url, 'https://api.githubcopilot.com/chat/completions');
  });

  it('explains how to fix a rejected token exchange', async () => {
    stubFetch({ [TOKEN_URL]: () => new Response('Bad credentials', { status: 401 }) });
    await assert.rejects(
      new CopilotSessionAuth('ghp_pat', NO_RETRY).get(),
      /HTTP 401.*Bad credentials[\s\S]*copilot-login/,
    );
  });
});

describe('static-key providers are unaffected', () => {
  it('still sends the configured api key and does not retry on 401', async () => {
    const calls = stubFetch({ 'https://example.test/': () => json({ error: 'x' }, 401) });
    const provider = new OpenAiCompatibleProvider({
      name: 'static',
      baseUrl: 'https://example.test/chat',
      apiKey: 'k',
      model: 'm',
      maxTokens: 10,
      temperature: 0,
      maxRetries: 0,
    });
    await assert.rejects(provider.complete({ messages: [{ role: 'user', content: 'a' }] }), /static error 401/);
    assert.equal(calls.length, 1);
    assert.equal(headersOf(calls[0]).authorization, 'Bearer k');
  });
});

describe('device flow login', () => {
  const DEVICE = 'https://github.com/login/device/code';
  const ACCESS = 'https://github.com/login/oauth/access_token';
  const device = { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };

  it('prompts, polls through pending and slow_down, and returns the token', async () => {
    const calls = stubFetch({
      [DEVICE]: () => json(device),
      [ACCESS]: (_c, n) =>
        n === 1
          ? json({ error: 'authorization_pending' })
          : n === 2
            ? json({ error: 'slow_down', interval: 10 })
            : json({ access_token: 'gho_new' }),
    });
    const sleeps: number[] = [];
    let prompt: unknown;
    const token = await loginWithDeviceFlow({
      http: NO_RETRY,
      sleep: async (ms) => void sleeps.push(ms),
      onPrompt: (p) => (prompt = p),
    });

    assert.equal(token, 'gho_new');
    assert.deepEqual(prompt, { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
    assert.deepEqual(sleeps, [5000, 5000, 10000]);
    const poll = JSON.parse(String(calls[1].init.body));
    assert.equal(poll.device_code, 'dc');
    assert.equal(poll.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  });

  it('fails when the user denies access', async () => {
    stubFetch({ [DEVICE]: () => json(device), [ACCESS]: () => json({ error: 'access_denied' }) });
    await assert.rejects(loginWithDeviceFlow({ http: NO_RETRY, sleep: async () => {}, onPrompt: () => {} }), /denied/);
  });

  it('fails when the device code expires', async () => {
    stubFetch({ [DEVICE]: () => json(device), [ACCESS]: () => json({ error: 'expired_token' }) });
    await assert.rejects(loginWithDeviceFlow({ http: NO_RETRY, sleep: async () => {}, onPrompt: () => {} }), /expired/);
  });
});

describe('token storage', () => {
  it('prefers the env token, then the saved file, then nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copilot-auth-'));
    const file = join(dir, 'nested', 'github-copilot.json');

    assert.equal(resolveGitHubToken(undefined, file), undefined);
    await saveGitHubToken('gho_saved', file);
    assert.equal(resolveGitHubToken(undefined, file), 'gho_saved');
    assert.equal(resolveGitHubToken('', file), 'gho_saved');
    assert.equal(resolveGitHubToken('  gho_env  ', file), 'gho_env');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { oauth_token: 'gho_saved' });
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  });

  it('treats a corrupt file as no credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copilot-auth-'));
    const file = join(dir, 'bad.json');
    await import('node:fs/promises').then((fs) => fs.writeFile(file, 'not json'));
    assert.equal(resolveGitHubToken(undefined, file), undefined);
  });
});
