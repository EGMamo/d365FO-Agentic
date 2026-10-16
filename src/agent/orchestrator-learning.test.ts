import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentOrchestrator, recoveryLesson, reflectOn, retrievalQuery } from './orchestrator.js';
import type { AppConfig } from '../config/index.js';
import type { LlmCompleteResponse, LlmMessage } from '../llm/types.js';
import type { TestCase, TestResult } from '../testing/types.js';
import { KnowledgeBase, type KbEntry } from '../knowledge/kb.js';

const tc: TestCase = {
  id: 'TC-9', source: 'local', title: 'Create vendor', module: 'Accounts payable', tags: ['smoke'],
  steps: [{ index: 1, action: 'Open All vendors', expected: 'List opens' }, { index: 2, action: 'Create vendor V1' }],
};

const tip: KbEntry = { id: 'tip-1', createdAt: '', kind: 'remediation', summary: 'Vendor groups', details: 'Pick a group first', tags: [], successCount: 0, failureCount: 0 };

interface Harness { prompts: string[]; outcomes: Array<{ ids: string[]; passed: boolean }>; upserts: Array<Record<string, unknown>>; saves: number; result: TestResult }

async function run(turns: LlmCompleteResponse[], over: Partial<AppConfig> = {}, known?: KbEntry, abortOnTurn?: number): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'orch-learn-'));
  const h = { prompts: [] as string[], outcomes: [] as Harness['outcomes'], upserts: [] as Harness['upserts'], saves: 0 };
  const cfg = {
    LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: false, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 20,
    AGENT_RELOOP_MAX_RETRIES: 0, AGENT_RELOOP_RETRY_ON: [], AGENT_RELOOP_COOLDOWN_MS: 0, REPORT_DIR: dir, KB_DIR: dir,
    D365_BASE_URL: 'https://fo.sandbox.operations.dynamics.com', D365_COMPANY: 'USMF', AGENT_ALLOW_DESTRUCTIVE: true, ...over,
  } as AppConfig;
  const ctl = new AbortController();
  let turn = 0;
  const llm = {
    name: 'fake',
    async complete(req: { messages: LlmMessage[] }) {
      if (req.messages.length === 1) h.prompts.push(req.messages[0].content);
      if (++turn === abortOnTurn) ctl.abort();
      return turns.shift()!;
    },
  };
  const mcp = { async listTools() { return []; }, async callTool() { return { content: 'ok', isError: false }; } };
  const kb = {
    retrieve: () => [tip], recipeFor: () => known, upsert(e: Record<string, unknown>) { h.upserts.push(e); return e; }, async save() { h.saves++; },
    recordOutcome(ids: string[], passed: boolean) { h.outcomes.push({ ids, passed }); return ids.length; },
  };
  const result = await new AgentOrchestrator({ cfg, llm, mcp, kb, mcpServers: ['playwright'] } as never).runTestCase(tc, ctl.signal);
  return { ...h, result };
}

const call = (name: string, args: Record<string, unknown>, id = name): LlmCompleteResponse => ({ text: '', stopReason: 'tool_use', toolCalls: [{ id, name, arguments: args }] });

describe('reflexion between attempts', () => {
  it('tells the retry what went wrong in the previous attempt', async () => {
    const h = await run(
      [
        call('report_step', { index: 1, durationMs: 0, status: 'passed', verified: true, observed: 'List' }),
        call('report_step', { index: 2, durationMs: 0, status: 'failed', observed: 'Vendor group is mandatory' }, 'b'),
        call('finish_test', { outcome: 'failed', errorMessage: 'Save failed: vendor group missing' }),
        call('report_step', { index: 1, durationMs: 0, status: 'passed', verified: true, observed: 'List' }, 'c'),
        call('report_step', { index: 2, durationMs: 0, status: 'passed' }, 'd'),
        call('finish_test', { outcome: 'passed' }, 'e'),
      ],
      { AGENT_RELOOP_MAX_RETRIES: 1, AGENT_RELOOP_RETRY_ON: ['failed'] },
    );
    assert.equal(h.result.outcome, 'passed');
    assert.equal(h.prompts.length, 2);
    assert.doesNotMatch(h.prompts[0], /This is a retry/);
    assert.match(h.prompts[1], /This is a retry/);
    assert.match(h.prompts[1], /vendor group missing/);
    assert.match(h.prompts[1], /Step 2 failed: Vendor group is mandatory/);
    assert.equal(h.result.failureCategory, undefined);
  });

  it('reflectOn mentions the known path and passed steps', () => {
    const text = reflectOn(
      { outcome: 'blocked', errorMessage: 'x', steps: [{ index: 1, durationMs: 0, status: 'passed' }, { index: 2, durationMs: 0, status: 'blocked', cause: 'not_found' }], policyBlocks: [], timeouts: ['browser_click'] },
      tip,
    );
    assert.match(text, /Steps that passed: 1/);
    assert.match(text, /Step 2 blocked \(not_found\)/);
    assert.match(text, /Timed out: browser_click/);
    assert.match(text, /known-good path/);
  });

  it('retrievalQuery covers title, module, tags and steps', () => {
    const q = retrievalQuery(tc);
    for (const w of ['Create vendor', 'Accounts payable', 'smoke', 'List opens', 'Create vendor V1']) assert.ok(q.includes(w), w);
  });
});

describe('failure triage and knowledge feedback', () => {
  it('classifies a failed case as an assertion failure and does not blame the knowledge used', async () => {
    const h = await run([call('finish_test', { outcome: 'failed', errorMessage: 'Total was 10, expected 12' })]);
    assert.equal(h.result.failureCategory, 'assertion');
    assert.deepEqual(h.outcomes, []);
  });

  it('counts a failure the hints could have caused against the knowledge used', async () => {
    const h = await run([
      call('report_step', { index: 1, durationMs: 0, status: 'blocked', cause: 'not_found', observed: 'No such menu item' }),
      call('finish_test', { outcome: 'blocked', errorMessage: 'All vendors could not be opened' }, 'b'),
    ]);
    assert.equal(h.result.failureCategory, 'not_found');
    assert.deepEqual(h.outcomes, [{ ids: ['tip-1'], passed: false }]);
    assert.ok(h.saves >= 1);
  });

  it('does not retry a case whose test data is missing, and files it as blocked by data', async () => {
    const h = await run([
      call('report_step', { index: 1, durationMs: 0, status: 'blocked', cause: 'missing_data', errorMessage: 'TBC - supplier group' }),
      call('finish_test', { outcome: 'blocked' }, 'b'),
    ], { AGENT_RELOOP_MAX_RETRIES: 1, AGENT_RELOOP_RETRY_ON: ['blocked'] });
    assert.equal(h.result.attemptCount, 1);
    assert.equal(h.result.failureCategory, 'blocked');
    assert.equal(h.result.steps[0].cause, 'missing_data');
  });

  it('does not blame the knowledge used for a sign-in problem', async () => {
    const h = await run([
      call('report_step', { index: 1, durationMs: 0, status: 'blocked', cause: 'sign_in', observed: 'MFA prompt' }),
      call('finish_test', { outcome: 'blocked', errorMessage: 'Sign-in asked for MFA' }, 'b'),
    ]);
    assert.equal(h.result.failureCategory, 'sign_in');
    assert.deepEqual(h.outcomes, []);
  });

  it('credits the knowledge used on a pass and does not learn in dry run', async () => {
    const pass = await run([call('report_step', { index: 1, durationMs: 0, status: 'passed', verified: true, observed: 'List' }), call('finish_test', { outcome: 'passed' })]);
    assert.deepEqual(pass.outcomes, [{ ids: ['tip-1'], passed: true }]);
    const dry = await run([call('report_step', { index: 1, durationMs: 0, status: 'passed', verified: true, observed: 'List' }), call('finish_test', { outcome: 'passed' })], { AGENT_DRY_RUN: true });
    assert.deepEqual(dry.outcomes, []);
  });

  it('counts a run blocked by missing data against neither the knowledge used nor the known-good path', async () => {
    const known = { ...tip, id: 'path-1', kind: 'recipe', summary: 'Known-good path for test case TC-9', testCaseId: 'TC-9' } as KbEntry;
    const h = await run([call('finish_test', { outcome: 'blocked', errorMessage: 'No access to the form' })], {}, known);
    assert.equal(h.result.failureCategory, 'blocked');
    assert.deepEqual(h.outcomes, []);
  });

  it('does not count a likely product defect against the known-good path it was given', async () => {
    const known = { ...tip, id: 'path-1', kind: 'recipe', summary: 'Known-good path for test case TC-9', testCaseId: 'TC-9' } as KbEntry;
    const h = await run([call('finish_test', { outcome: 'failed', errorMessage: 'Total was 10, expected 12' })], {}, known);
    assert.deepEqual(h.outcomes, []);
  });

  it('counts a run that could not find its way against the hints and the known-good path', async () => {
    const known = { ...tip, id: 'path-1', kind: 'recipe', summary: 'Known-good path for test case TC-9', testCaseId: 'TC-9' } as KbEntry;
    const h = await run(
      [call('report_step', { index: 1, durationMs: 0, status: 'failed', cause: 'not_found', observed: 'No New button' }), call('finish_test', { outcome: 'failed', errorMessage: 'New button is gone' }, 'b')],
      {},
      known,
    );
    assert.deepEqual(h.outcomes, [{ ids: ['tip-1'], passed: false }, { ids: ['path-1'], passed: false }]);
  });
});

describe('interrupted runs', () => {
  it('marks the case interrupted, does not retry it and learns nothing from it', async () => {
    const known = { ...tip, id: 'path-1', kind: 'recipe', summary: 'Known-good path for test case TC-9', testCaseId: 'TC-9' } as KbEntry;
    const h = await run(
      [call('report_step', { index: 1, durationMs: 0, status: 'failed', observed: 'Browser closed' }), call('finish_test', { outcome: 'failed', errorMessage: 'x' }, 'b')],
      { AGENT_RELOOP_MAX_RETRIES: 2, AGENT_RELOOP_RETRY_ON: ['failed', 'blocked'] },
      known,
      1,
    );
    assert.equal(h.result.interrupted, true);
    assert.equal(h.result.outcome, 'blocked');
    assert.equal(h.result.failureCategory, 'infrastructure');
    assert.match(h.result.errorMessage ?? '', /^Run interrupted, not a test result/);
    assert.equal(h.result.attemptCount, 1);
    assert.deepEqual(h.outcomes, []);
    assert.deepEqual(h.upserts, []);
  });

  it('leaves a run that was not interrupted unmarked', async () => {
    const h = await run([call('finish_test', { outcome: 'failed', errorMessage: 'x' })]);
    assert.equal(h.result.interrupted, undefined);
  });
});

describe('learning from a recovered test', () => {
  const failedAttempt = { outcome: 'failed' as const, errorMessage: 'Save failed', steps: [{ index: 2, durationMs: 0, status: 'failed' as const, errorMessage: 'Vendor group is mandatory' }] };
  const passedAttempt = { outcome: 'passed' as const, steps: [], path: ['-- step 1 passed', 'browser_click: Vendor group', 'browser_type: Vendor group = 10'] };

  it('records what broke and the route that worked', () => {
    const lesson = recoveryLesson(tc, [failedAttempt, passedAttempt]);
    assert.ok(lesson);
    assert.equal(lesson.kind, 'remediation');
    assert.match(lesson.summary, /Recovered TC-9 after step 2 failed/);
    assert.match(lesson.details, /Vendor group is mandatory/);
    assert.match(lesson.details, /browser_type: Vendor group = 10/);
    assert.doesNotMatch(lesson.details, /-- step/);
    assert.ok(lesson.tags.includes('self-healed'));
  });

  it('teaches nothing when the first attempt passed or no actions were recorded', () => {
    assert.equal(recoveryLesson(tc, [passedAttempt]), undefined);
    assert.equal(recoveryLesson(tc, [failedAttempt, { ...passedAttempt, path: ['-- step 1 passed'] }]), undefined);
    assert.equal(recoveryLesson(tc, [passedAttempt, failedAttempt]), undefined);
  });

  it('saves a lesson when a retry passes after a failure', async () => {
    const h = await run(
      [
        call('finish_test', { outcome: 'failed', errorMessage: 'Save failed' }),
        call('playwright__browser_click', { element: 'Vendor group' }, 'c1'),
        call('report_step', { index: 1, durationMs: 0, status: 'passed', verified: true, observed: 'List' }, 'r1'),
        call('finish_test', { outcome: 'passed' }, 'f2'),
      ],
      { AGENT_RELOOP_MAX_RETRIES: 1, AGENT_RELOOP_RETRY_ON: ['failed'] },
    );
    assert.equal(h.result.outcome, 'passed');
    assert.ok(h.upserts.some((u) => String(u.summary).startsWith('Recovered TC-9')));
  });
});

describe('learning with a real knowledge base', () => {
  it('stops offering a known-good path that keeps failing and records a fresh one on the next pass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-kb-'));
    const kb = new KnowledgeBase(dir);
    await kb.load();
    const hint = kb.upsert({ kind: 'remediation', summary: 'Create vendor needs a vendor group', details: 'Pick a group first', tags: [], module: 'Accounts payable' });
    const cfg = {
      LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: false, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 20,
      AGENT_RELOOP_MAX_RETRIES: 0, AGENT_RELOOP_RETRY_ON: [], AGENT_RELOOP_COOLDOWN_MS: 0, REPORT_DIR: dir, KB_DIR: dir,
      D365_BASE_URL: 'https://fo.sandbox.operations.dynamics.com', D365_COMPANY: 'USMF', AGENT_ALLOW_DESTRUCTIVE: true,
    } as unknown as AppConfig;
    const mcp = { async listTools() { return []; }, async callTool() { return { content: 'ok', isError: false }; } };
    const once = async (turns: LlmCompleteResponse[]): Promise<{ prompt: string; result: TestResult }> => {
      let prompt = '';
      const llm = { name: 'fake', async complete(req: { messages: LlmMessage[] }) { if (req.messages.length === 1) prompt = req.messages[0].content; return turns.shift()!; } };
      const result = await new AgentOrchestrator({ cfg, llm, mcp, kb, mcpServers: ['playwright'] } as never).runTestCase(tc);
      return { prompt, result };
    };
    const pass = (element: string): LlmCompleteResponse[] => [
      call('playwright__browser_click', { element, ref: 'e1' }),
      call('report_step', { index: 1, status: 'passed', verified: true, observed: 'List' }, 'a'),
      call('report_step', { index: 2, status: 'passed' }, 'b'),
      call('finish_test', { outcome: 'passed' }, 'c'),
    ];
    const defect = (): LlmCompleteResponse[] => [call('finish_test', { outcome: 'failed', errorMessage: 'Total was 10, expected 12' })];
    const lost = (): LlmCompleteResponse[] => [
      call('report_step', { index: 1, status: 'blocked', cause: 'not_found', observed: 'No New button on the page' }),
      call('finish_test', { outcome: 'blocked', errorMessage: 'The New button is gone' }, 'b'),
    ];

    assert.equal((await once(pass('New button'))).result.outcome, 'passed');
    assert.match(kb.recipeFor(tc.id)?.details ?? '', /click "New button"/);
    assert.equal(kb.all().find((e) => e.id === hint.id)?.successCount, 1);

    // Two likely product defects in a row blame neither the hint nor the path.
    await once(defect());
    await once(defect());
    assert.equal(kb.all().find((e) => e.id === hint.id)?.failureCount, 0);
    assert.ok(kb.recipeFor(tc.id));

    // Two runs that could not find their way (the UI changed) make the path stale.
    assert.match((await once(lost())).prompt, /Known-good path/);
    await once(lost());
    assert.equal(kb.recipeFor(tc.id), undefined);
    assert.equal(kb.all().find((e) => e.id === hint.id)?.failureCount, 2);

    const again = await once(pass('Add vendor button'));
    assert.doesNotMatch(again.prompt, /Known-good path/);
    assert.match(again.prompt, /Create vendor needs a vendor group/);
    assert.match(kb.recipeFor(tc.id)?.details ?? '', /click "Add vendor button"/);

    const reloaded = new KnowledgeBase(dir);
    await reloaded.load();
    assert.match(reloaded.recipeFor(tc.id)?.details ?? '', /Add vendor button/);
  });

  it('keeps nothing the model claims to have learned in a dry run', async () => {
    const h = await run([call('finish_test', { outcome: 'passed', learnings: [{ kind: 'recipe', summary: 'Create vendor', details: 'Click New' }] })], { AGENT_DRY_RUN: true });
    assert.deepEqual(h.upserts, []);
    assert.equal(h.saves, 0);
  });
});
