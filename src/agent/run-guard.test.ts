import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentOrchestrator } from './orchestrator.js';
import { AttemptGuard, destructiveClick, detectAuthProblem, detectUnreachable, normalizeTarget } from './run-guard.js';
import type { AppConfig } from '../config/index.js';
import type { LlmCompleteResponse } from '../llm/types.js';
import type { TestCase } from '../testing/types.js';

describe('detection helpers', () => {
  it('spots MFA and refused credentials, not ordinary pages', () => {
    assert.equal(detectAuthProblem('Approve sign in request\nOpen your Authenticator app')?.kind, 'mfa');
    assert.equal(detectAuthProblem('AADSTS50126: Error validating credentials')?.kind, 'credentials');
    assert.equal(detectAuthProblem('Your account or password is incorrect.')?.kind, 'credentials');
    assert.equal(detectAuthProblem('### Page state\n- heading "Vendors"'), undefined);
  });

  it('spots a navigation to a missing page', () => {
    assert.ok(detectUnreachable('HTTP ERROR 404', false));
    assert.ok(detectUnreachable('net::ERR_NAME_NOT_RESOLVED', false));
    assert.ok(detectUnreachable('anything', true));
    assert.ok(!detectUnreachable('### Page state - heading "All vendors"', false));
  });

  it('treats a hash or trailing slash as the same target', () => {
    assert.equal(normalizeTarget('https://X.example/a/?mi=1#top'), normalizeTarget('https://x.example/a?mi=1'));
    assert.notEqual(normalizeTarget('https://x.example/?mi=1'), normalizeTarget('https://x.example/?mi=2'));
  });

  it('flags only destructive clicks', () => {
    assert.ok(destructiveClick('browser_click', { element: 'Delete line' }));
    assert.equal(destructiveClick('browser_click', { element: 'New' }), undefined);
    assert.equal(destructiveClick('browser_type', { element: 'Delete' }), undefined);
  });
});

describe('AttemptGuard', () => {
  it('stops on the time budget', () => {
    let t = 0;
    const g = new AttemptGuard({ AGENT_TEST_TIMEOUT_MS: 1000 }, () => t);
    assert.equal(g.checkBudgets(), undefined);
    t = 1500;
    assert.equal(g.checkBudgets()?.reason, 'timeout');
  });

  it('stops on the token budget, and a limit of 0 disables it', () => {
    const g = new AttemptGuard({ AGENT_MAX_TOKENS_PER_TEST: 100 });
    g.recordUsage({ inputTokens: 80, outputTokens: 30 });
    assert.equal(g.checkBudgets()?.reason, 'budget');
    const off = new AttemptGuard({ AGENT_MAX_TOKENS_PER_TEST: 0 });
    off.recordUsage({ inputTokens: 1e9 });
    assert.equal(off.checkBudgets(), undefined);
  });

  it('counts consecutive errors and resets on success', () => {
    const g = new AttemptGuard({ AGENT_MAX_CONSECUTIVE_ERRORS: 3 });
    assert.equal(g.recordToolResult(true), undefined);
    assert.equal(g.recordToolResult(true), undefined);
    assert.equal(g.recordToolResult(false), undefined);
    assert.equal(g.recordToolResult(true), undefined);
    assert.equal(g.recordToolResult(true), undefined);
    assert.equal(g.recordToolResult(true)?.reason, 'errors');
  });

  it('remembers a missing target and stops after enough different ones', () => {
    const g = new AttemptGuard({ AGENT_MAX_UNREACHABLE_TARGETS: 2 });
    assert.equal(g.recordUnreachable('https://x.example/a', '404'), undefined);
    assert.match(g.previouslyFailed('https://x.example/a#h') ?? '', /already tried/);
    assert.equal(g.previouslyFailed('https://x.example/b'), undefined);
    assert.equal(g.recordUnreachable('https://x.example/b', '404')?.retryable, false);
  });

  it('can be told to ignore auth problems', () => {
    const p = { kind: 'mfa' as const, evidence: 'Enter code' };
    assert.equal(new AttemptGuard({}).authStop(p)?.retryable, false);
    assert.equal(new AttemptGuard({ AGENT_STOP_ON_AUTH_FAILURE: false }).authStop(p), undefined);
  });
});

const BASE = 'https://x.sandbox.operations.dynamics.com';
const tc: TestCase = { id: 'T1', source: 'local', title: 't', steps: [{ index: 1, action: 'Open' }, { index: 2, action: 'Next' }] };
const call = (name: string, args: Record<string, unknown>, id = name): LlmCompleteResponse => ({ text: '', stopReason: 'tool_use', toolCalls: [{ id, name, arguments: args }] });
const finish = (args: Record<string, unknown> = { outcome: 'passed' }) => call('finish_test', args, 'fin');

async function run(turns: LlmCompleteResponse[], pages: string[] = [], over: Partial<AppConfig> = {}) {
  let attempts = 0;
  const reached: Array<Record<string, unknown>> = [];
  const cfg = {
    LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: false, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 40,
    AGENT_RELOOP_MAX_RETRIES: 2, AGENT_RELOOP_RETRY_ON: ['failed', 'blocked'], AGENT_RELOOP_COOLDOWN_MS: 0,
    D365_BASE_URL: BASE, D365_COMPANY: 'USMF', REPORT_DIR: await mkdtemp(join(tmpdir(), 'rg-')), ...over,
  } as AppConfig;
  const llm = { name: 'fake', async complete() { attempts++; return turns.shift() ?? finish({ outcome: 'blocked' }); } };
  const mcp = {
    async listTools() { return []; },
    async callTool(_s: string, _t: string, args: Record<string, unknown>) { reached.push(args); return { content: pages.shift() ?? 'page', isError: false }; },
  };
  const kb = { retrieve: () => [], recipeFor: () => undefined, upsert() {}, async save() {} };
  const result = await new AgentOrchestrator({ cfg, llm, mcp, kb, mcpServers: ['playwright'] } as never).runTestCase(tc);
  return { result, attempts: () => attempts, reached };
}

describe('orchestrator run limits', () => {
  it('does not retry a missing page and does not navigate to it twice', async () => {
    const url = `${BASE}/?mi=Nope`;
    const { result, reached } = await run(
      [call('playwright__browser_navigate', { url }, 'a'), call('playwright__browser_navigate', { url }, 'b'), call('report_step', { index: 1, status: 'blocked', cause: 'not_found' }), finish({ outcome: 'blocked', errorMessage: 'missing' })],
      ['HTTP ERROR 404 page not found'],
    );
    assert.equal(reached.length, 1, 'second navigation never reached the browser');
    assert.equal(result.attemptCount, 1, 'no reloop');
    assert.equal(result.outcome, 'blocked');
  });

  it('stops at MFA and skips the reloop', async () => {
    const { result, attempts } = await run([call('playwright__browser_navigate', { url: BASE }), finish()], ['Approve sign in request']);
    assert.equal(result.outcome, 'blocked');
    assert.match(result.errorMessage ?? '', /multi-factor/);
    assert.equal(result.attemptCount, 1);
    assert.equal(attempts(), 1);
  });

  it('refuses a destructive click unless allowed', async () => {
    const turns = () => [call('playwright__browser_click', { element: 'Delete', ref: 'e1' }), finish()];
    const blocked = await run(turns());
    assert.equal(blocked.reached.length, 0);
    assert.equal(blocked.result.policyBlocks?.length, 1);
    const allowed = await run(turns(), [], { AGENT_ALLOW_DESTRUCTIVE: true });
    assert.equal(allowed.reached.filter((a) => !('textGone' in a)).length, 1, 'the click reached the browser (the F&O busy wait after it is not counted)');
  });

  it('stops when the token budget is spent', async () => {
    const turn = { ...call('recall_values', {}), usage: { inputTokens: 600, outputTokens: 0 } };
    const { result } = await run([turn, { ...turn }, { ...turn }, finish()], [], { AGENT_MAX_TOKENS_PER_TEST: 1000 });
    assert.match(result.errorMessage ?? '', /token budget|budget of 1000/);
    assert.equal(result.attemptCount, 1);
  });

  it('stops after repeated failing tool calls', async () => {
    const bad = (i: number) => call('nonexistent_tool', { n: i }, `x${i}`);
    const { result } = await run(Array.from({ length: 10 }, (_, i) => bad(i)), [], { AGENT_MAX_CONSECUTIVE_ERRORS: 3, AGENT_RELOOP_MAX_RETRIES: 0 });
    assert.match(result.errorMessage ?? '', /3 tool calls in a row failed/);
  });
});
