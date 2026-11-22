import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentOrchestrator, rollupOutcome } from './orchestrator.js';
import type { AppConfig } from '../config/index.js';
import type { LlmCompleteRequest, LlmCompleteResponse } from '../llm/types.js';
import type { TestCase } from '../testing/types.js';

const call = (name: string, args: Record<string, unknown>, id = name): LlmCompleteResponse => ({ text: '', stopReason: 'tool_use', toolCalls: [{ id, name, arguments: args }] });
const finish = (outcome = 'passed', errorMessage?: string) => call('finish_test', { outcome, ...(errorMessage ? { errorMessage } : {}) }, 'fin');
const step = (index: number, status: string, extra: Record<string, unknown> = {}, id = `r${index}`) => call('report_step', { index, status, ...extra }, id);

const supplier: TestCase = {
  id: '10', source: 'local', title: 'Create supplier',
  steps: [
    { index: 1, action: 'Open All suppliers and click New' },
    { index: 2, action: 'Select Group (TBC - confirm UK supplier group)' },
    { index: 3, action: 'Enter the address name (TBC - address name)' },
    { index: 4, action: 'Save' },
    { index: 5, action: 'Filter All suppliers for the new account', expected: 'The supplier is listed' },
  ],
};
const plain: TestCase = { id: 'P', source: 'local', title: 'plain', steps: [{ index: 1, action: 'Open' }, { index: 2, action: 'Save' }, { index: 3, action: 'Find it' }] };

interface Run {
  turns?: LlmCompleteResponse[];
  cfg?: Partial<AppConfig>;
  testCase?: TestCase;
  /** Reply to the preflight classification; by default every placeholder is missing. */
  classify?: (req: LlmCompleteRequest) => LlmCompleteResponse;
}

async function run({ turns = [], cfg: over = {}, testCase = supplier, classify }: Run) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-out-'));
  const cfg = {
    LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: false, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 30, REPORT_DIR: dir, D365_BASE_URL: 'https://x.sandbox.operations.dynamics.com',
    D365_COMPANY: 'USMF', AGENT_TOOL_TIMEOUT_MS: 60000, AGENT_NAV_TIMEOUT_MS: 90000, AGENT_FNO_AUTO_WAIT: false, AGENT_LEARN_PAGES: false, ...over,
  } as AppConfig;
  const toolResults: string[] = [];
  const prompts: string[] = [];
  let classifyCalls = 0;
  const llm = {
    name: 'fake',
    async complete(req: LlmCompleteRequest) {
      if (req.tools?.some((t) => t.name === 'classify_placeholders')) {
        classifyCalls++;
        if (classify) return classify(req);
        const ids = [...req.messages[0].content.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
        return call('classify_placeholders', { placeholders: ids.map((id) => ({ id, kind: 'missing' })) });
      }
      if (prompts.length === 0) prompts.push(req.messages[0].content);
      const last = req.messages.at(-1);
      if (last?.role === 'tool') toolResults.push(last.content);
      return turns.shift() ?? finish('blocked');
    },
  };
  const browser: Array<[string, Record<string, unknown>]> = [];
  const mcp = { async listTools() { return []; }, async callTool(_s: string, tool: string, args: Record<string, unknown>) { browser.push([tool, args]); return { content: 'page', isError: false }; } };
  const result = await new AgentOrchestrator({ cfg, llm, mcp, mcpServers: ['playwright'] } as never).runTestCase(testCase);
  return { result, toolResults, prompts, browser, classifyCalls };
}

describe('preflight', () => {
  it('ends a case with missing data blocked before the browser or the agent is used', async () => {
    const { result, browser, prompts, classifyCalls } = await run({});
    assert.equal(classifyCalls, 1);
    assert.equal(prompts.length, 0, 'the agent loop never ran');
    assert.deepEqual(browser, []);
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.failureCategory, 'blocked');
    assert.equal(result.usage?.turns, 1);
    assert.deepEqual(result.steps.map((s) => [s.index, s.status]), [[1, 'skipped'], [2, 'blocked'], [3, 'blocked'], [4, 'skipped'], [5, 'skipped']]);
    assert.match(result.errorMessage ?? '', /^Missing test data: .*2 placeholders .*step 2 "TBC - confirm UK supplier group", step 3 "TBC - address name".*--preflight partial/);
  });

  it('runs a case whose placeholders are all values it may generate', async () => {
    const { result, prompts } = await run({
      classify: () => call('classify_placeholders', { placeholders: [{ id: 0, kind: 'generate' }, { id: 1, kind: 'config' }] }),
      turns: [finish('blocked', 'stopped')],
    });
    assert.equal(prompts.length, 1);
    assert.equal(result.errorMessage, 'stopped');
  });

  it('in partial mode records the missing steps as blocked up front and tells the agent', async () => {
    const { result, prompts } = await run({ cfg: { AGENT_PREFLIGHT: 'partial' }, turns: [step(1, 'passed'), finish('blocked')] });
    assert.match(prompts[0], /Already recorded as blocked[\s\S]*step 2 \(Unresolved placeholder: "TBC - confirm UK supplier group"\.\); step 3/);
    assert.deepEqual(result.steps.map((s) => [s.index, s.status]).sort(), [[1, 'passed'], [2, 'blocked'], [3, 'blocked']]);
  });

  it('is skipped entirely when off', async () => {
    const { classifyCalls, prompts } = await run({ cfg: { AGENT_PREFLIGHT: 'off' } });
    assert.equal(classifyCalls, 0);
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(prompts[0], /Already recorded/);
  });

  it('runs the case normally when the check cannot be made', async () => {
    const { prompts, result } = await run({ classify: () => { throw new Error('bad gateway reply'); }, turns: [finish('blocked', 'ran')] });
    assert.equal(prompts.length, 1);
    assert.equal(result.errorMessage, 'ran');
  });
});

describe('failures that follow a blocked step', () => {
  const off = { AGENT_PREFLIGHT: 'off' as const };

  it('records a failure after a missing-data block as blocked, and the case as blocked', async () => {
    const { result, toolResults } = await run({
      cfg: off,
      turns: [step(1, 'passed'), step(2, 'blocked', { cause: 'missing_data', errorMessage: 'TBC - confirm UK supplier group' }), step(5, 'failed', { errorMessage: 'Supplier not found' }), finish('failed')],
    });
    const reply = JSON.parse(toolResults[2]);
    assert.equal(reply.recordedAs, 'blocked');
    assert.match(reply.note, /independent: true/);
    const s5 = result.steps.find((s) => s.index === 5);
    assert.equal(s5?.status, 'blocked');
    assert.equal(s5?.cause, 'missing_data');
    assert.match(s5?.errorMessage ?? '', /Depends on step 2[\s\S]*Supplier not found/);
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.failureCategory, 'blocked');
    assert.match(result.errorMessage ?? '', /^Not counted as failed: no step failed\. Step 2 blocked \(missing_data\)/);
  });

  it('keeps a failure the agent marks independent', async () => {
    const { result } = await run({
      cfg: off,
      turns: [step(2, 'blocked', { cause: 'not_found' }), step(5, 'failed', { independent: true, errorMessage: 'Wrong total' }), finish('failed')],
    });
    assert.equal(result.steps.find((s) => s.index === 5)?.status, 'failed');
    assert.equal(result.outcome, 'failed');
    assert.equal(result.failureCategory, 'not_found');
  });

  it('keeps a failure before the blocked step, or after a block for another reason', async () => {
    const { result } = await run({
      cfg: off, testCase: plain,
      turns: [step(1, 'failed', { errorMessage: 'Error on open' }), step(2, 'blocked', { cause: 'other' }), step(3, 'failed', {}, 'r3'), finish('failed')],
    });
    assert.deepEqual(result.steps.map((s) => s.status), ['failed', 'blocked', 'failed']);
    assert.equal(result.outcome, 'failed');
  });

  it('calls a case failed when a step failed, even if the agent said blocked', async () => {
    const { result } = await run({ cfg: off, testCase: plain, turns: [step(1, 'failed', { errorMessage: 'Posting error' }), step(2, 'blocked', { cause: 'missing_data' }), finish('blocked')] });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.runState, 'failed');
    assert.equal(result.errorMessage, 'Step 1 failed: Posting error');
  });

  it('does not override a stop the run imposed', async () => {
    const { result } = await run({ cfg: { ...off, AGENT_MAX_REPEATED_CALLS: 1 }, testCase: plain, turns: [step(1, 'failed'), step(2, 'passed'), step(2, 'passed', {}, 'r2b')] });
    assert.equal(result.outcome, 'blocked');
    assert.match(result.errorMessage ?? '', /^Agent stopped/);
  });

  it('rollupOutcome leaves consistent verdicts alone', () => {
    assert.deepEqual(rollupOutcome('failed', [{ index: 1, status: 'failed', durationMs: 0 }]), { outcome: 'failed' });
    assert.deepEqual(rollupOutcome('blocked', [{ index: 1, status: 'blocked', durationMs: 0 }]), { outcome: 'blocked' });
    assert.deepEqual(rollupOutcome('failed', []), { outcome: 'failed' }, 'with no step verdicts the model is not contradicted');
    assert.deepEqual(rollupOutcome('failed', [{ index: 1, status: 'passed', durationMs: 0 }, { index: 2, status: 'skipped', durationMs: 0 }]), { outcome: 'failed' });
  });
});

describe('report_steps', () => {
  it('records several verdicts in one call and reports per-entry errors without dropping the rest', async () => {
    const { result, toolResults } = await run({
      cfg: { AGENT_PREFLIGHT: 'off' }, testCase: plain,
      turns: [call('report_steps', { steps: [{ index: 1, status: 'passed' }, { index: 9, status: 'blocked' }, 'junk'] }), call('report_steps', { steps: [{ index: 2, status: 'skipped' }] }, 'b'), finish('blocked')],
    });
    const reply = JSON.parse(toolResults[0]);
    assert.equal(reply.results.length, 3);
    assert.deepEqual(reply.results[0], { ok: true, recorded: 1 });
    assert.match(reply.results[1].error, /Invalid step index 9/);
    assert.match(reply.results[2].error, /Invalid step index undefined/);
    assert.deepEqual(result.steps.map((s) => [s.index, s.status]), [[1, 'passed'], [2, 'skipped']]);
  });

  it('applies the expected-result rule to each entry', async () => {
    const { toolResults } = await run({ cfg: { AGENT_PREFLIGHT: 'off' }, turns: [call('report_steps', { steps: [{ index: 5, status: 'passed' }] }), finish('blocked')] });
    assert.match(JSON.parse(toolResults[0]).results[0].error, /call report_steps again with verified=true/);
  });

  it('refuses an empty or oversized batch', async () => {
    const { toolResults } = await run({
      cfg: { AGENT_PREFLIGHT: 'off' }, testCase: plain,
      turns: [call('report_steps', { steps: [] }, 'a'), call('report_steps', { steps: Array.from({ length: 4 }, () => ({ index: 1, status: 'passed' })) }, 'b'), finish('blocked')],
    });
    assert.match(toolResults[0], /non-empty array/);
    assert.match(toolResults[1], /has 3 steps; got 4/);
  });

  it('stops the attempt on a sign-in problem, without recording the entries after it', async () => {
    const { result } = await run({
      cfg: { AGENT_PREFLIGHT: 'off', AGENT_STOP_ON_AUTH_FAILURE: true }, testCase: plain,
      turns: [call('report_steps', { steps: [{ index: 1, status: 'blocked', cause: 'sign_in' }, { index: 2, status: 'skipped' }] }), finish('passed')],
    });
    assert.deepEqual(result.steps.map((s) => s.index), [1]);
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.failureCategory, 'sign_in');
  });
});

describe('placeholders shared by several steps', () => {
  const shared: TestCase = {
    id: 'S', source: 'local', title: 'shared',
    steps: [
      { index: 1, action: 'Group (TBC - supplier group) and type (TBC - supplier type)' },
      { index: 2, action: 'Open the group TBC - supplier group' },
      { index: 3, action: 'Check the type (TBC - supplier type)' },
      { index: 4, action: 'Enter TBC' },
      { index: 5, action: 'Enter TBC again' },
    ],
  };

  it('blocks the unreported steps that use the placeholder the agent was blocked on, and only that one', async () => {
    const { result, toolResults } = await run({
      cfg: { AGENT_PREFLIGHT: 'off' }, testCase: shared,
      turns: [step(1, 'blocked', { cause: 'missing_data', errorMessage: 'Placeholder "TBC - supplier group" is not specified.' }), finish('blocked')],
    });
    const reply = JSON.parse(toolResults[0]);
    assert.deepEqual(reply.alsoBlocked, [2]);
    assert.match(reply.alsoBlockedNote, /do not run it/);
    assert.deepEqual(result.steps.map((s) => [s.index, s.status]), [[1, 'blocked'], [2, 'blocked']]);
    assert.match(result.steps[1].errorMessage ?? '', /"TBC - supplier group", which step 1 was blocked on/);
  });

  it('does not treat bare TBC markers as the same placeholder, or overwrite steps already reported', async () => {
    const { toolResults } = await run({
      cfg: { AGENT_PREFLIGHT: 'off' }, testCase: shared,
      turns: [step(2, 'passed'), step(4, 'blocked', { cause: 'missing_data' }), step(1, 'blocked', { cause: 'missing_data', errorMessage: 'TBC - supplier group' }), finish('blocked')],
    });
    assert.equal(JSON.parse(toolResults[1]).alsoBlocked, undefined);
    assert.equal(JSON.parse(toolResults[2]).alsoBlocked, undefined);
  });
});

describe('discarding unsaved changes', () => {
  const click = call('playwright__browser_click', { target: 'New' }, 'c');
  const keys = (browser: Array<[string, Record<string, unknown>]>) => browser.filter(([t]) => t === 'browser_press_key').map(([, a]) => a.key);
  const discards = (browser: Array<[string, Record<string, unknown>]>) => keys(browser).filter((k) => k === 'Control+Shift+F5').length;
  const off = { AGENT_PREFLIGHT: 'off' as const };

  it('discards them when a case that changed data does not pass', async () => {
    const { browser } = await run({ cfg: off, testCase: plain, turns: [click, step(1, 'passed'), finish('blocked')] });
    assert.deepEqual(keys(browser), ['Control+Shift+F5', 'Alt+Shift+Q'], 'revert, then close discarding; never Escape');
  });

  it('leaves a passed case, a case that changed nothing, a dry run and a disabled setting alone', async () => {
    const passed = await run({ cfg: off, testCase: plain, turns: [click, step(1, 'passed'), step(2, 'passed'), step(3, 'passed'), finish('passed')] });
    assert.equal(discards(passed.browser), 0);
    const untouched = await run({ cfg: off, testCase: plain, turns: [call('playwright__browser_snapshot', {}, 's'), finish('blocked')] });
    assert.equal(discards(untouched.browser), 0);
    const dry = await run({ cfg: { ...off, AGENT_DRY_RUN: true }, testCase: plain, turns: [click, finish('blocked')] });
    assert.equal(discards(dry.browser), 0);
    const disabled = await run({ cfg: { ...off, AGENT_DISCARD_UNSAVED: false }, testCase: plain, turns: [click, finish('blocked')] });
    assert.equal(discards(disabled.browser), 0);
  });
});

describe('review fixes', () => {
  const off = { AGENT_PREFLIGHT: 'off' as const };
  const batch = (...responses: LlmCompleteResponse[]): LlmCompleteResponse => ({ text: '', stopReason: 'tool_use', toolCalls: responses.flatMap((r, i) => r.toolCalls.map((c) => ({ ...c, id: `${c.id}-${i}` }))) });

  it('never turns a sign-in failure into blocked: the stop still fires and the cause is kept', async () => {
    const { result } = await run({
      cfg: { ...off, AGENT_STOP_ON_AUTH_FAILURE: true }, testCase: plain,
      turns: [step(1, 'blocked', { cause: 'not_found' }), step(2, 'failed', { cause: 'sign_in', observed: 'MFA prompt' }), step(3, 'passed'), finish('passed')],
    });
    const s2 = result.steps.find((s) => s.index === 2);
    assert.equal(s2?.status, 'failed');
    assert.equal(s2?.cause, 'sign_in');
    assert.equal(result.steps.find((s) => s.index === 3), undefined, 'the run stopped');
    assert.equal(result.failureCategory, 'sign_in');
  });

  it('keeps the test open once when a failure is recorded as blocked in the same response as finish_test', async () => {
    const { result, toolResults } = await run({
      cfg: off,
      turns: [
        step(2, 'blocked', { cause: 'not_found' }),
        batch(step(5, 'failed', { errorMessage: 'Total is 90, expected 100' }), finish('failed')),
        batch(step(5, 'failed', { independent: true, errorMessage: 'Total is 90, expected 100' }, 'again'), finish('failed')),
      ],
    });
    assert.match(toolResults.join('\n'), /testStillOpen[\s\S]*independent: true/);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.steps.find((s) => s.index === 5)?.status, 'failed');
  });

  it('accepts the blocked verdict when the model confirms by finishing again', async () => {
    const { result } = await run({
      cfg: off,
      turns: [step(2, 'blocked', { cause: 'missing_data' }), batch(step(5, 'failed'), finish('failed')), finish('failed')],
    });
    assert.equal(result.outcome, 'blocked');
  });

  it('keeps the reported cause in the converted step message', async () => {
    const { result } = await run({ cfg: off, turns: [step(2, 'blocked', { cause: 'missing_data' }), step(5, 'failed', { cause: 'other', errorMessage: 'gone' }), finish('blocked')] });
    assert.match(result.steps.find((s) => s.index === 5)?.errorMessage ?? '', /Reported failure \(other\): gone/);
  });

  it('propagates only from a block the agent reported itself, and only the placeholder it named', async () => {
    const tcase: TestCase = {
      id: 'Q', source: 'local', title: 'q',
      steps: [
        { index: 1, action: 'Pick <vendor name> in group TBC' },
        { index: 2, action: 'Rename <vendor name>' },
        { index: 3, action: 'Group (TBC - supplier group)' },
        { index: 4, action: 'Check TBC - supplier group' },
      ],
    };
    const unnamed = await run({ cfg: off, testCase: tcase, turns: [step(1, 'blocked', { cause: 'missing_data', errorMessage: 'The group is TBC' }), finish('blocked')] });
    assert.deepEqual(unnamed.result.steps.map((s) => s.index), [1], 'the agent named no placeholder that step 2 shares');
    const converted = await run({
      cfg: off, testCase: tcase,
      turns: [step(1, 'blocked', { cause: 'not_found' }), step(3, 'failed', { cause: 'missing_data', errorMessage: 'TBC - supplier group' }), finish('blocked')],
    });
    assert.equal(converted.result.steps.find((s) => s.index === 4), undefined, 'a converted failure does not propagate');
  });

  it('never propagates a placeholder preflight classified as one the agent may generate', async () => {
    const tcase: TestCase = { id: 'G', source: 'local', title: 'g', steps: [{ index: 1, action: 'Name (TBC - supplier name)' }, { index: 2, action: 'Search TBC - supplier name' }] };
    const { result } = await run({
      testCase: tcase,
      classify: () => call('classify_placeholders', { placeholders: [{ id: 0, kind: 'generate' }, { id: 1, kind: 'generate' }] }),
      turns: [step(1, 'blocked', { cause: 'missing_data', errorMessage: 'TBC - supplier name' }), finish('blocked')],
    });
    assert.deepEqual(result.steps.map((s) => s.index), [1]);
  });

  it('releases the steps recorded because of a step that is later reported as done', async () => {
    const tcase: TestCase = {
      id: 'R', source: 'local', title: 'r',
      steps: [{ index: 1, action: 'Group (TBC - supplier group)' }, { index: 2, action: 'Save' }, { index: 3, action: 'Check TBC - supplier group' }, { index: 4, action: 'Find it' }],
    };
    const { result, toolResults } = await run({
      cfg: off, testCase: tcase,
      turns: [
        step(1, 'blocked', { cause: 'missing_data', errorMessage: 'TBC - supplier group' }),
        step(4, 'failed', { errorMessage: 'not found' }),
        step(1, 'passed', {}, 'again'),
        finish('failed'),
      ],
    });
    const reply = JSON.parse(toolResults[2]);
    assert.deepEqual(reply.released, [3]);
    assert.deepEqual(reply.restoredAsFailed, [4]);
    assert.deepEqual(result.steps.map((s) => [s.index, s.status]).sort(), [[1, 'passed'], [4, 'failed']]);
    assert.equal(result.outcome, 'failed');
  });

  it('in partial mode, a step blocked before the run does not turn a later failure into blocked', async () => {
    const { result } = await run({ cfg: { AGENT_PREFLIGHT: 'partial' }, turns: [step(1, 'passed'), step(5, 'failed', { errorMessage: 'Posting error' }), finish('failed')] });
    assert.equal(result.steps.find((s) => s.index === 5)?.status, 'failed');
    assert.equal(result.outcome, 'failed');
  });

  it('in partial mode, runs a step that only lacks its expected result instead of blocking it', async () => {
    const tcase: TestCase = { id: 'E', source: 'local', title: 'e', steps: [{ index: 1, action: 'Post the invoice', expected: 'TBC - confirm posting message' }, { index: 2, action: 'Open the voucher' }] };
    const { prompts, result } = await run({ cfg: { AGENT_PREFLIGHT: 'partial' }, testCase: tcase, turns: [step(1, 'blocked', { cause: 'missing_data' }), step(2, 'failed', { errorMessage: 'No voucher' }), finish('failed')] });
    assert.doesNotMatch(prompts[0], /Already recorded as blocked/);
    assert.match(prompts[0], /Expected results the test case leaves unset: step 1 \("TBC - confirm posting message"\)/);
    assert.equal(result.steps.find((s) => s.index === 2)?.status, 'failed', 'a step with only an unset expected result is no blocker');
  });

  it('counts the preflight call in the case usage when the case runs', async () => {
    const { result } = await run({
      classify: () => ({ ...call('classify_placeholders', { placeholders: [{ id: 0, kind: 'generate' }, { id: 1, kind: 'generate' }] }), usage: { inputTokens: 300, outputTokens: 40 } }),
      turns: [{ ...finish('blocked'), usage: { inputTokens: 10, outputTokens: 5 } }],
    });
    assert.equal(result.usage?.turns, 2);
    assert.equal(result.usage?.inputTokens, 310);
    assert.equal(result.usage?.outputTokens, 45);
  });

  it('discards after a form fill that errored part-way, and stops if the revert fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-disc-'));
    const cfg = { LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: false, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 10, REPORT_DIR: dir, D365_BASE_URL: 'https://x.sandbox.operations.dynamics.com', D365_COMPANY: 'USMF', AGENT_FNO_AUTO_WAIT: false, AGENT_LEARN_PAGES: false, ...off } as AppConfig;
    const turns = [call('playwright__browser_fill_form', { fields: [] }, 'f'), finish('blocked')];
    const keys: unknown[] = [];
    const llm = { name: 'fake', async complete() { return turns.shift() ?? finish('blocked'); } };
    const mcp = {
      async listTools() { return []; },
      async callTool(_s: string, tool: string, args: Record<string, unknown>) {
        if (tool === 'browser_press_key') { keys.push(args.key); return { content: 'no focus', isError: true }; }
        return { content: 'Error: target not found', isError: true };
      },
    };
    await new AgentOrchestrator({ cfg, llm, mcp, mcpServers: ['playwright'] } as never).runTestCase(plain);
    assert.deepEqual(keys, ['Control+Shift+F5'], 'a failed revert stops the sequence instead of closing the page');
  });
});
