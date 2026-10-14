import { mkdir, writeFile } from 'node:fs/promises';
import { finishTrace, snapshotFiles, traceOutputDir, tracingEnabled } from '../mcp/playwright-trace.js';
import { join } from 'node:path';
import type { AppConfig } from '../config/index.js';
import type { LlmProvider } from '../llm/index.js';
import type { LlmMessage, LlmTool, LlmToolCall } from '../llm/types.js';
import type { McpManager, McpToolDescriptor } from '../mcp/manager.js';
import { knownPathSummary, type KbEntry, type KbEntryInput, type KnowledgeBase } from '../knowledge/kb.js';
import { mergeMenuItems, PageMap, pageKey, type ControlAction } from '../knowledge/page-map.js';
import { isMissingTarget, isSnapshotRef, pageInfo, ranLocators, responseText, slimSnapshot } from '../mcp/playwright-response.js';
import type { RunState, StepCause, StepResult, StepStatus, TestCase, TestResult } from '../testing/types.js';
import { classifyFailure, hintsMayBeAtFault, type FailureCategory } from '../testing/triage.js';
import { D365ODataClient, hasAppRegistration, ODATA_TOOL, ODATA_TOOL_NAME } from '../d365fo/entra.js';
import { CREDENTIAL_TOOL, CREDENTIAL_TOOL_NAME, browserTypeArgs, credentialFor, mcpErrorText, redactSecrets } from '../d365fo/login.js';
import { isMenuItemName, loadMenuItems, menuItemUrl, openMenuItemTool, OPEN_MENU_ITEM_TOOL_NAME, resolveMenuItem, type MenuItem } from '../d365fo/navigation.js';
import { baseSystemPrompt, testCaseUserPrompt } from './prompts.js';
import { compactHistory } from './context.js';
import { Guardrails } from './guardrails.js';
import { toUnavailable } from '../llm/errors.js';
import { AttemptGuard, destructiveClick, detectAuthProblem, detectUnreachable, type RunStop } from './run-guard.js';
import { parseCodeLine, ReplayRecorder, stepFunction, type RecordedStep } from '../replay/code.js';
import { replayBlocker, ReplayStore } from '../replay/store.js';

const DEFAULT_MAX_REPEATED_CALLS = 3;
const DEFAULT_CONTEXT_KEEP_RECENT = 3;
/** An attempt that keeps hitting the guardrails is stopped instead of probing for a way around them. */
const MAX_POLICY_BLOCKS = 5;
const MAX_LEARNINGS = 10;
const STEP_STATUSES: readonly StepStatus[] = ['passed', 'failed', 'skipped', 'blocked'];
const STEP_CAUSES: readonly StepCause[] = ['not_found', 'no_access', 'sign_in', 'other'];
const LEARNING_KINDS = ['selector', 'recipe', 'remediation', 'doc'] as const;
const MAX_DATA_KEYS = 20;
/** Lines kept in a recorded known-good path. */
const MAX_PATH_LINES = 60;
/** Text F&O shows on its blocking overlay while a form loads or a request is processed. */
const FNO_BUSY_TEXT = 'Please wait';
const LIMITS = { dataKey: 60, dataValue: 500, observed: 2000, error: 2000, summary: 1000, learningSummary: 200, learningDetails: 2000, blockNote: 300 };

const LOCAL_TOOLS: LlmTool[] = [
  {
    name: 'report_step',
    description:
      'Record the verdict for a single test step. Call this immediately after observing the result of each step.',
    inputSchema: {
      type: 'object',
      required: ['index', 'status'],
      properties: {
        index: { type: 'integer', description: '1-based step index' },
        status: { type: 'string', enum: ['passed', 'failed', 'skipped', 'blocked'] },
        observed: { type: 'string', description: 'What actually happened' },
        errorMessage: { type: 'string' },
        cause: {
          type: 'string',
          enum: ['not_found', 'no_access', 'sign_in', 'other'],
          description:
            'Why a failed or blocked step could not be done. not_found: a page, menu item, path or record named in the test case does not exist. no_access: the user lacks permission. sign_in: sign-in needs MFA or was refused. These stop pointless retries.',
        },
        verified: {
          type: 'boolean',
          description:
            'Required when status is "passed" and the step has an expected result. true only if you checked the expected result against a fresh page snapshot (quote what you saw in `observed`); false if you could not check it.',
        },
      },
    },
  },
  {
    name: 'record_value',
    description:
      'Save a value created or discovered during this run (a generated vendor account, an order number) so later steps and the report can use it. Never store secrets. Use `recall_values` to read them back.',
    inputSchema: {
      type: 'object',
      required: ['key', 'value'],
      properties: { key: { type: 'string' }, value: { type: 'string' } },
    },
  },
  {
    name: 'recall_values',
    description: 'Return every value saved with `record_value` in this run.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'finish_test',
    description: 'End the test case with an overall verdict and optional reusable learnings.',
    inputSchema: {
      type: 'object',
      required: ['outcome'],
      properties: {
        outcome: { type: 'string', enum: ['passed', 'failed', 'skipped', 'blocked'] },
        summary: { type: 'string' },
        errorMessage: { type: 'string' },
        learnings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['kind', 'summary', 'details'],
            properties: {
              kind: { type: 'string', enum: ['selector', 'recipe', 'remediation', 'doc'] },
              summary: { type: 'string' },
              details: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'kb_search',
    description: 'Search the local knowledge base for prior learnings relevant to a query.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' }, k: { type: 'integer', default: 5 } },
    },
  },
];

export const PAGE_NOTE_TOOL_NAME = 'd365_page_note';
const PAGE_NOTE_TOOL: LlmTool = {
  name: PAGE_NOTE_TOOL_NAME,
  description:
    'Save a short, reusable fact about the F&O form the browser is on now, e.g. "Vendor group is on the General FastTab; expand it first" or "Save shows a confirmation dialog". It is shown the next time any test opens this form. Generic facts only: never data values, names or secrets.',
  inputSchema: { type: 'object', required: ['note'], properties: { note: { type: 'string' } } },
};

/** Actions after which F&O typically shows its busy overlay while the server processes the change. */
const FNO_SETTLE_TOOLS = new Set(['browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_handle_dialog']);

/** Browser tools whose resolved locator is worth learning, and the action it is learned as. */
const LEARNABLE: Record<string, ControlAction> = {
  browser_click: 'click',
  browser_type: 'fill',
  browser_fill_form: 'fill',
  browser_select_option: 'select',
  browser_hover: 'hover',
};

interface RunOptions {
  cfg: AppConfig;
  llm: LlmProvider;
  mcp: McpManager;
  kb: KnowledgeBase;
  mcpServers: string[];
}

/** Starts with "Run interrupted" so triage files it under infrastructure, not as a test failure. */
export const INTERRUPTED_MESSAGE = 'Run interrupted, not a test result: stopped (Ctrl+C or SIGTERM) before the case finished.';

interface AttemptResult {
  interrupted?: boolean;
  outcome: StepStatus;
  runState: RunState;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepResult[];
  artifacts: string[];
  learnings: string[];
  policyBlocks: string[];
  timeouts: string[];
  data: Record<string, string>;
  errorMessage?: string;
  /** Successful UI actions of the attempt, used to record what worked after an earlier failure. */
  path?: string[];
  /** A retry of the whole test cannot change the outcome (missing target, sign-in, spent budget). */
  nonRetryable?: boolean;
}

interface DispatchResult {
  content: string;
  done?: boolean;
  outcome?: StepStatus;
  errorMessage?: string;
  policyBlocked?: boolean;
  /** The call failed, for the consecutive-error limit. */
  errored?: boolean;
  /** A run limit was hit: the attempt ends here. */
  stop?: RunStop;
}

export class AgentOrchestrator {
  private cfg: AppConfig;
  private llm: LlmProvider;
  private mcp: McpManager;
  private browserTypeSchema?: Record<string, unknown>;
  private kb: KnowledgeBase;
  private mcpServers: string[];
  private guardrails: Guardrails;
  private reportedHiddenTools = false;
  private odata?: D365ODataClient;
  private menuItems?: MenuItem[];
  private pageMap?: PageMap;
  /** MCP tool lists do not change during a run; listing them once saves a round trip per attempt. */
  private toolCache = new Map<string, McpToolDescriptor[]>();
  private replays: ReplayStore;

  constructor(opts: RunOptions) {
    this.cfg = opts.cfg;
    this.llm = opts.llm;
    this.mcp = opts.mcp;
    this.kb = opts.kb;
    this.mcpServers = opts.mcpServers;
    this.guardrails = new Guardrails(opts.cfg, opts.mcpServers);
    this.replays = new ReplayStore(opts.cfg.KB_DIR ?? './knowledge');
    if (hasAppRegistration(opts.cfg) && opts.cfg.D365_BASE_URL) this.odata = new D365ODataClient(opts.cfg);
  }

  /** `signal` (Ctrl+C) stops the case at the next model turn; the result is then marked `interrupted` and nothing is learned from it. */
  async runTestCase(tc: TestCase, signal?: AbortSignal): Promise<TestResult> {
    const attempts: AttemptResult[] = [];
    const maxAttempts = Math.max(1, this.cfg.AGENT_RELOOP_MAX_RETRIES + 1);

    // A case with a recorded passing run is first replayed without the AI; only when that fails does the AI run it.
    const replay = await this.replay(tc, signal);
    if (replay?.attempt) attempts.push(replay.attempt);
    const replayNote = replay?.info.outcome === 'failed'
      ? `A replay of the last passing run (its recorded Playwright code, without the AI) failed at step ${replay.info.step}: ${replay.info.error}. The page or data may have changed since: work the steps out again rather than repeating the recorded path blindly.`
      : undefined;

    for (let attempt = 1; attempt <= maxAttempts && !replay?.attempt; attempt++) {
      const result = await this.runAttempt(tc, attempts.at(-1), signal, attempt === 1 ? replayNote : undefined);
      attempts.push(result);

      if (result.interrupted || result.nonRetryable || !shouldRetry(result.outcome, this.cfg.AGENT_RELOOP_RETRY_ON, attempt, maxAttempts)) break;
      if (this.cfg.AGENT_RELOOP_COOLDOWN_MS > 0) {
        await sleep(this.cfg.AGENT_RELOOP_COOLDOWN_MS);
      }
      // Interrupted between attempts: keep the finished attempt as the result instead of starting another.
      if (signal?.aborted) break;
    }

    const first = attempts[0];
    const final = attempts.at(-1) ?? {
      outcome: 'blocked' as StepStatus,
      runState: 'blocked' as RunState,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      steps: [],
      artifacts: [],
      learnings: [],
      policyBlocks: [],
      timeouts: [],
      data: {},
      errorMessage: 'No attempts were executed',
    };

    if (final.outcome === 'passed' && attempts.length > 1 && !this.cfg.AGENT_DRY_RUN) await this.learnFromRecovery(tc, attempts);

    const previous = attempts.length > 1 ? attempts[attempts.length - 2] : undefined;
    const policyBlocks = Array.from(new Set(attempts.flatMap((a) => a.policyBlocks))).slice(0, 20);
    const timeouts = Array.from(new Set(attempts.flatMap((a) => a.timeouts))).slice(0, 20);
    const finalState: RunState =
      final.outcome === 'passed' || final.outcome === 'skipped' ? 'completed' : final.outcome === 'failed' ? 'failed' : 'blocked';

    const failureCategory = classifyFailure({ ...final, policyBlocks, timeouts });
    return {
      testCaseId: tc.id,
      title: tc.title,
      outcome: final.outcome,
      ...(failureCategory ? { failureCategory } : {}),
      runState: finalState,
      startedAt: first.startedAt,
      finishedAt: final.finishedAt,
      durationMs: attempts.reduce((sum, a) => sum + a.durationMs, 0),
      steps: final.steps,
      artifacts: Array.from(new Set(attempts.flatMap((a) => a.artifacts))),
      errorMessage: final.errorMessage,
      learnings: final.learnings,
      ...(policyBlocks.length ? { policyBlocks } : {}),
      ...(timeouts.length ? { timeouts } : {}),
      ...(Object.keys(final.data).length ? { data: final.data } : {}),
      ...(final.interrupted ? { interrupted: true } : {}),
      ...(replay ? { replay: replay.info } : {}),
      attemptCount: attempts.length,
      firstOutcome: first.outcome,
      previousOutcome: previous?.outcome,
      retryHistory: attempts.map((a, idx) => ({
        attempt: idx + 1,
        outcome: a.outcome,
        runState: a.runState,
        startedAt: a.startedAt,
        finishedAt: a.finishedAt,
        durationMs: a.durationMs,
        errorMessage: a.errorMessage,
        retryReason: idx > 0 ? `Retry after attempt ${idx} due to ${attempts[idx - 1]?.outcome}` : undefined,
      })),
    };
  }

  private async runAttempt(tc: TestCase, previous?: AttemptResult, signal?: AbortSignal, replayNote?: string): Promise<AttemptResult> {
    const startedAt = new Date();
    const artifactsDir = join(this.cfg.REPORT_DIR, 'artifacts', tc.id);
    await mkdir(artifactsDir, { recursive: true });

    const mcpTools: McpToolDescriptor[] = [];
    for (const server of this.mcpServers) {
      try {
        let tools = this.toolCache.get(server);
        if (!tools) {
          tools = await this.mcp.listTools(server);
          this.toolCache.set(server, tools);
        }
        mcpTools.push(...tools);
        const bt = tools.find((t) => t.server === 'playwright' && t.name === 'browser_type');
        if (bt) this.browserTypeSchema = bt.inputSchema;
      } catch (e) {
        console.warn(`[agent] failed to list tools for MCP server '${server}': ${(e as Error).message}`);
      }
    }
    const { allowed: allowedTools, blocked: hiddenTools } = this.guardrails.splitTools(mcpTools);
    if (this.cfg.AGENT_VERBOSE && hiddenTools.length && !this.reportedHiddenTools) {
      this.reportedHiddenTools = true;
      this.log(`hiding ${hiddenTools.length} tool(s) not on the allowlist: ${hiddenTools.map((t) => `${t.server}__${t.name}`).join(', ')}`);
    }
    const canOpenPages = this.mcpServers.includes('playwright') && Boolean(this.cfg.D365_BASE_URL);
    if (this.mcpServers.includes('playwright') && this.cfg.AGENT_LEARN_PAGES !== false && !this.pageMap) {
      try {
        this.pageMap = await PageMap.load(this.cfg.KB_DIR ?? './knowledge');
      } catch (e) {
        console.warn(`[agent] page learning is off for this run: ${(e as Error).message}`);
      }
    }
    // Reloaded per case, so forms learned by earlier cases of this run can be opened by caption.
    if (canOpenPages) this.menuItems = mergeMenuItems(await loadMenuItems(this.cfg.KB_DIR ?? './knowledge'), this.pageMap?.menuItems() ?? []);
    const tools: LlmTool[] = [
      ...allowedTools.map((t) => ({
        name: `${t.server}__${t.name}`,
        description: `[${t.server}] ${t.description}`,
        inputSchema: t.inputSchema,
      })),
      ...LOCAL_TOOLS,
      CREDENTIAL_TOOL,
      ...(this.odata ? [ODATA_TOOL] : []),
      ...(canOpenPages && this.menuItems ? [openMenuItemTool(this.menuItems)] : []),
      ...(this.pageMap ? [PAGE_NOTE_TOOL] : []),
    ];

    const retrieved = this.kb.retrieve(retrievalQuery(tc), tc.tags ?? [], 5, tc.module);

    let traceBefore: Set<string> | undefined;
    if (tracingEnabled(this.cfg) && this.mcpServers.includes('playwright')) {
      try {
        traceBefore = await snapshotFiles(traceOutputDir(this.cfg));
        await this.mcp.callTool('playwright', 'browser_start_tracing', {}, this.cfg.AGENT_TOOL_TIMEOUT_MS);
      } catch (e) {
        traceBefore = undefined;
        console.warn(`[agent] could not start a Playwright trace (${(e as Error).message}); continuing without one`);
      }
    }

    const knownPath = this.kb.recipeFor(tc.id);
    const messages: LlmMessage[] = [
      { role: 'user', content: testCaseUserPrompt(tc, retrieved, knownPath, previous ? reflectOn(previous, knownPath) : replayNote) },
    ];
    const steps: StepResult[] = [];
    const learnings: string[] = [];
    const artifacts: string[] = [];
    const policyBlocks: string[] = [];
    const timeouts: string[] = [];
    const data: Record<string, string> = {};
    const path: string[] = [];
    const recorder = new ReplayRecorder();
    const page = { key: undefined as string | undefined, hinted: new Set<string>() };
    let outcome: StepStatus = 'blocked';
    let overallError: string | undefined;
    let stopped = false;
    const maxRepeats = this.cfg.AGENT_MAX_REPEATED_CALLS ?? DEFAULT_MAX_REPEATED_CALLS;
    let lastCallKey: string | undefined;
    let repeats = 0;
    const guard = new AttemptGuard(this.cfg);
    const flags = { nonRetryable: false };

    try {
      for (let iter = 0; iter < this.cfg.AGENT_MAX_STEPS && !stopped && !signal?.aborted; iter++) {
        const compacted = compactHistory(messages, this.cfg.AGENT_CONTEXT_KEEP_RECENT ?? DEFAULT_CONTEXT_KEEP_RECENT);
        if (this.cfg.AGENT_VERBOSE && compacted > 0) this.log(`context: collapsed ${compacted} older tool result(s)`);
        const overBudget = guard.checkBudgets();
        if (overBudget) {
          outcome = 'blocked';
          overallError = overBudget.message;
          flags.nonRetryable ||= !overBudget.retryable;
          break;
        }
        const response = await this.llm.complete({
          system: baseSystemPrompt(this.cfg),
          messages,
          tools,
        });
        guard.recordUsage(response.usage);
        if (this.cfg.AGENT_VERBOSE && response.usage) {
          const u = response.usage;
          this.log(`tokens: in=${u.inputTokens ?? '?'} out=${u.outputTokens ?? '?'}${u.cacheReadTokens ? ` cached=${u.cacheReadTokens}` : ''}`);
        }

        messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });
        if (this.cfg.AGENT_VERBOSE && response.text) this.log(`model: ${response.text}`);

        if (response.toolCalls.length === 0) {
          overallError = this.clean(response.text || 'Model produced no tool calls and no final verdict.', LIMITS.error);
          outcome = 'blocked';
          break;
        }

        for (const call of response.toolCalls) {
          const callKey = `${call.name}:${JSON.stringify(call.arguments)}`;
          repeats = callKey === lastCallKey ? repeats + 1 : 1;
          lastCallKey = callKey;
          if (maxRepeats > 0 && repeats > maxRepeats) {
            outcome = 'blocked';
            overallError = `Agent stopped: ${call.name} was called ${repeats} times in a row with identical arguments (limit ${maxRepeats}, AGENT_MAX_REPEATED_CALLS). The run is not making progress.`;
            stopped = true;
            break;
          }
          if (this.cfg.AGENT_VERBOSE) this.log(`→ ${call.name} ${JSON.stringify(call.arguments)}`);
          const dispatched = await this.dispatch(call, {
            tc,
            steps,
            learnings,
            artifactsDir,
            artifacts,
            policyBlocks,
            timeouts,
            data,
            path,
            recorder,
            guard,
            flags,
            page,
          });
          if (this.cfg.AGENT_VERBOSE) this.log(`← ${dispatched.content}`);
          messages.push({
            role: 'tool',
            content: dispatched.content,
            toolCallId: call.id,
            toolName: call.name,
          });
          const stop = dispatched.stop ?? (dispatched.done ? undefined : guard.recordToolResult(Boolean(dispatched.errored)));
          if (dispatched.done) {
            outcome = dispatched.outcome ?? 'blocked';
            overallError = dispatched.errorMessage;
            stopped = true;
          } else if (stop) {
            outcome = 'blocked';
            overallError = stop.message;
            flags.nonRetryable ||= !stop.retryable;
            stopped = true;
            break;
          } else if (dispatched.policyBlocked && policyBlocks.length >= MAX_POLICY_BLOCKS) {
            outcome = 'blocked';
            overallError = `Agent stopped: ${policyBlocks.length} tool calls were refused by the guardrails (e.g. ${policyBlocks[0]}). The run was steered outside its permitted scope.`;
            stopped = true;
            break;
          }
        }

        if (response.stopReason === 'end_turn' && !stopped) break;
      }
    } catch (e) {
      const unavailable = toUnavailable(e);
      if (unavailable) throw unavailable;
      outcome = 'blocked';
      overallError = this.clean(`Transient orchestration failure: ${(e as Error).message}`, LIMITS.error);
    }

    // Ctrl+C also reaches the browser, so whatever this attempt reported cannot be trusted as a verdict.
    const interrupted = Boolean(signal?.aborted);
    if (interrupted) {
      outcome = 'blocked';
      overallError = INTERRUPTED_MESSAGE;
    }

    if ((outcome === 'failed' || outcome === 'blocked') && !overallError) {
      const bad = steps.find((s) => s.status === 'failed' || s.status === 'blocked');
      overallError = bad
        ? this.clean(`Step ${bad.index} ${bad.status}: ${bad.errorMessage ?? bad.observed ?? 'no details were reported'}`, LIMITS.error)
        : 'The model ended the test without a reason.';
    }

    if (outcome === 'passed' && !this.cfg.AGENT_DRY_RUN) {
      const unverified = unverifiedSteps(tc, steps);
      if (unverified.length) {
        outcome = 'blocked';
        overallError = `Not counted as passed: step ${unverified.join(', ')} ${unverified.length > 1 ? 'have' : 'has'} an expected result that was not verified against the page. Nothing was checked, so no pass is claimed.`;
      }
    }

    if (outcome === 'passed' && !this.cfg.AGENT_DRY_RUN && path.some((l) => !l.startsWith('-- '))) {
      await this.saveKnownPath(tc, path);
    }
    if (outcome === 'passed' && !this.cfg.AGENT_DRY_RUN && !interrupted) await this.saveReplay(tc, recorder);
    if (!this.cfg.AGENT_DRY_RUN && !interrupted) {
      const category = classifyFailure({ outcome, errorMessage: overallError, steps, policyBlocks, timeouts });
      await this.learnFromOutcome(tc, outcome, category, steps, retrieved, knownPath);
    }

    await this.savePages();

    if (traceBefore) {
      try {
        await this.mcp.callTool('playwright', 'browser_stop_tracing', {}, this.cfg.AGENT_TOOL_TIMEOUT_MS);
        artifacts.push(...(await finishTrace(this.cfg, traceBefore, outcome)));
      } catch (e) {
        console.warn(`[agent] could not finish the Playwright trace: ${(e as Error).message}`);
      }
    }

    const finishedAt = new Date();
    const runState: RunState = outcome === 'failed' ? 'failed' : outcome === 'blocked' ? 'blocked' : 'completed';
    return {
      outcome,
      runState,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      steps,
      artifacts,
      errorMessage: overallError,
      learnings,
      policyBlocks,
      timeouts,
      data,
      path,
      ...(flags.nonRetryable ? { nonRetryable: true } : {}),
      ...(interrupted ? { interrupted: true } : {}),
    };
  }

  private async dispatch(
    call: LlmToolCall,
    ctx: {
      tc: TestCase;
      steps: StepResult[];
      learnings: string[];
      artifactsDir: string;
      artifacts: string[];
      policyBlocks: string[];
      timeouts: string[];
      data: Record<string, string>;
      /** Successful UI actions of this attempt, saved as the case's known-good path if it passes. */
      path: string[];
      /** The Playwright code of those actions, saved for replay without the AI if the attempt passes. */
      recorder: ReplayRecorder;
      guard: AttemptGuard;
      flags: { nonRetryable: boolean };
      /** The F&O form the browser is on, and the forms whose learned hints were already shown this attempt. */
      page: { key?: string; hinted: Set<string> };
    },
    opts: { noHint?: boolean } = {},
  ): Promise<DispatchResult> {
    const args: Record<string, unknown> =
      call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments : {};
    const fail = (error: string): DispatchResult => ({ content: JSON.stringify({ error }), errored: true });

    if (call.name === 'report_step') {
      const validIndexes = ctx.tc.steps.map((s) => s.index);
      const index = typeof args.index === 'string' && /^\d+$/.test(args.index) ? Number(args.index) : args.index;
      if (typeof index !== 'number' || !validIndexes.includes(index)) {
        return fail(`Invalid step index ${JSON.stringify(index)}. Use one of: ${validIndexes.join(', ')}. Nothing was recorded.`);
      }
      if (!STEP_STATUSES.includes(args.status as StepStatus)) {
        return fail(`Invalid status ${JSON.stringify(args.status)}. Use one of: ${STEP_STATUSES.join(', ')}. Nothing was recorded.`);
      }
      const expected = ctx.tc.steps.find((s) => s.index === index)?.expected;
      if (expected && args.status === 'passed' && typeof args.verified !== 'boolean') {
        return fail(`Step ${index} has an expected result (${this.clean(expected, 200)}). Check it against a fresh browser_snapshot, then call report_step again with verified=true (quote what you saw in \`observed\`), or verified=false if you could not check it. Nothing was recorded.`);
      }
      const step: StepResult = {
        index,
        status: args.status as StepStatus,
        ...(typeof args.verified === 'boolean' ? { verified: args.verified } : {}),
        ...((args.status === 'failed' || args.status === 'blocked') && STEP_CAUSES.includes(args.cause as StepCause) ? { cause: args.cause as StepCause } : {}),
        observed: typeof args.observed === 'string' ? this.clean(args.observed, LIMITS.observed) : undefined,
        errorMessage: typeof args.errorMessage === 'string' ? this.clean(args.errorMessage, LIMITS.error) : undefined,
        durationMs: 0,
      };
      const existing = ctx.steps.findIndex((s) => s.index === index);
      if (existing >= 0) ctx.steps[existing] = step;
      else ctx.steps.push(step);
      ctx.path.push(`-- step ${index} ${step.status}`);
      ctx.recorder.step(index);
      if (args.status === 'failed' || args.status === 'blocked') {
        if (args.cause === 'not_found' || args.cause === 'no_access') {
          ctx.flags.nonRetryable = true;
        } else if (args.cause === 'sign_in') {
          const stop = ctx.guard.authStop({ kind: 'mfa', evidence: step.observed ?? 'reported by the model' });
          if (stop) return { content: JSON.stringify({ ok: true, recorded: step.index }), stop };
        }
      }
      return { content: JSON.stringify({ ok: true, recorded: step.index }) };
    }
    if (call.name === 'record_value') {
      const key = typeof args.key === 'string' ? args.key.trim() : '';
      const value = typeof args.value === 'string' ? args.value : '';
      if (!key || !value) return fail('Both `key` and `value` are required, as non-empty strings. Nothing was recorded.');
      if (!(key in ctx.data) && Object.keys(ctx.data).length >= MAX_DATA_KEYS) return fail(`At most ${MAX_DATA_KEYS} values can be recorded per run. Nothing was recorded.`);
      ctx.data[this.clean(key, LIMITS.dataKey)] = this.clean(value, LIMITS.dataValue);
      return { content: JSON.stringify({ ok: true, recorded: key }) };
    }
    if (call.name === 'recall_values') return { content: JSON.stringify(ctx.data) };
    if (call.name === CREDENTIAL_TOOL_NAME) {
      const field = String(args.field);
      const secret = credentialFor(this.cfg, args.field);
      if (!secret) {
        return {
          content: JSON.stringify({
            error: `No value configured for ${field}: set D365_USERNAME / D365_PASSWORD in .env. Mark the step BLOCKED.`,
          }),
        };
      }
      if (this.cfg.AGENT_DRY_RUN) return { content: JSON.stringify({ dryRun: true, note: 'Skipped credential entry' }) };
      const ref = (args.ref ?? args.target) as string | undefined;
      if (!ref) {
        return { content: JSON.stringify({ error: 'Missing `ref`: take the element ref from the latest browser_snapshot and call again.' }) };
      }
      try {
        const res = await this.mcp.callTool(
          'playwright',
          'browser_type',
          browserTypeArgs(this.browserTypeSchema, {
            ref,
            element: (args.element as string | undefined) ?? `${field} field`,
            text: secret,
            submit: Boolean(args.submit),
          }),
        );
        const body = res.isError
          ? { error: `The credential was configured, but typing it failed: ${mcpErrorText(res.content)}` }
          : { ok: true, entered: args.field };
        return { content: redactSecrets(this.cfg, JSON.stringify(body)) };
      } catch (e) {
        return { content: redactSecrets(this.cfg, JSON.stringify({ error: `Typing the credential failed: ${(e as Error).message}` })) };
      }
    }
    if (call.name === ODATA_TOOL_NAME) {
      if (!this.odata) return fail('No Entra app registration is configured (D365_TENANT_ID, D365_CLIENT_ID, D365_CLIENT_SECRET).');
      try {
        const out = await this.odata.query({
          entity: String(args.entity ?? ''),
          filter: typeof args.filter === 'string' ? args.filter : undefined,
          select: typeof args.select === 'string' ? args.select : undefined,
          top: typeof args.top === 'number' ? args.top : undefined,
          crossCompany: args.crossCompany === true,
        });
        return { content: redactSecrets(this.cfg, out), errored: out.startsWith('{"error"') };
      } catch (e) {
        return fail(redactSecrets(this.cfg, (e as Error).message));
      }
    }
    if (call.name === OPEN_MENU_ITEM_TOOL_NAME) return this.openMenuItem(call, args, ctx);
    if (call.name === PAGE_NOTE_TOOL_NAME) {
      if (!this.pageMap) return fail('Page learning is off (AGENT_LEARN_PAGES=false). Nothing was saved.');
      if (!ctx.page.key) return fail('No F&O form is open yet. Open the form first, then save the note.');
      const note = typeof args.note === 'string' ? this.clean(args.note, 200) : '';
      if (!note.trim()) return fail('Give the note text. Nothing was saved.');
      this.pageMap.addNote(ctx.page.key, note);
      await this.savePages();
      return { content: JSON.stringify({ ok: true, savedFor: ctx.page.key }) };
    }
    if (call.name === 'kb_search') {
      const q = typeof args.query === 'string' ? args.query : '';
      const requested = Number(args.k ?? 5);
      const k = Number.isFinite(requested) ? Math.min(20, Math.max(1, Math.trunc(requested))) : 5;
      const hits = this.kb.retrieve(q, ctx.tc.tags ?? [], k);
      return { content: JSON.stringify(hits) };
    }
    if (call.name === 'finish_test') {
      if (!STEP_STATUSES.includes(args.outcome as StepStatus)) {
        return fail(`Invalid outcome ${JSON.stringify(args.outcome)}. Use one of: ${STEP_STATUSES.join(', ')}. The test is still open; call finish_test again.`);
      }
      const outcome = args.outcome as StepStatus;
      const errorMessage = typeof args.errorMessage === 'string' ? this.clean(args.errorMessage, LIMITS.error) : undefined;
      const summary = typeof args.summary === 'string' ? this.clean(args.summary, LIMITS.summary) : '';
      if (summary) ctx.learnings.push(summary);
      // A dry run acts on nothing, so what the model claims to have learned from it is not kept.
      const rawLearnings = Array.isArray(args.learnings) && !this.cfg.AGENT_DRY_RUN ? args.learnings.slice(0, MAX_LEARNINGS) : [];
      for (const l of rawLearnings as Array<Record<string, unknown>>) {
        if (!l || !LEARNING_KINDS.includes(l.kind as (typeof LEARNING_KINDS)[number])) continue;
        if (typeof l.summary !== 'string' || typeof l.details !== 'string' || !l.summary.trim()) continue;
        this.kb.upsert({
          kind: l.kind as (typeof LEARNING_KINDS)[number],
          summary: this.clean(l.summary, LIMITS.learningSummary),
          details: this.clean(l.details, LIMITS.learningDetails),
          module: ctx.tc.module,
          testCaseId: ctx.tc.id,
          tags: ctx.tc.tags ?? [],
          successCount: outcome === 'passed' ? 1 : 0,
          failureCount: outcome === 'failed' ? 1 : 0,
        });
      }
      if (rawLearnings.length) await this.kb.save();
      return {
        content: JSON.stringify({ ok: true }),
        done: true,
        outcome,
        errorMessage,
      };
    }

    const idx = call.name.indexOf('__');
    if (idx < 0) return fail(`Unknown tool: ${call.name}`);
    const server = call.name.slice(0, idx);
    const toolName = call.name.slice(idx + 2);
    if (server === 'playwright' && toolName === 'browser_navigate' && typeof args.url === 'string') {
      const again = ctx.guard.previouslyFailed(args.url);
      if (again) {
        return {
          content: JSON.stringify({ error: `${again}. Do not look for another route to it. Report the step as blocked with cause "not_found" and continue with the next step that does not depend on it, or call finish_test.` }),
          errored: true,
        };
      }
    }
    const destructive =
      server === 'playwright' && !ctx.guard.allowDestructive ? destructiveClick(toolName, args) : undefined;
    const denied =
      this.guardrails.checkCall(server, toolName, args, ctx.tc.legalEntity) ??
      (destructive ? `${destructive}; destructive actions are off (set AGENT_ALLOW_DESTRUCTIVE=true to allow them)` : undefined);
    if (denied) {
      const note = this.clean(`${call.name}: ${denied}`, LIMITS.blockNote);
      ctx.policyBlocks.push(note);
      console.warn(`[guardrail] blocked ${note}`);
      return {
        content: JSON.stringify({
          error: `Blocked by policy: ${denied}. Retrying will not help; use a permitted approach or mark the step BLOCKED.`,
        }),
        policyBlocked: true,
      };
    }
    try {
      if (this.cfg.AGENT_DRY_RUN && server === 'playwright' && isMutatingBrowserTool(toolName)) {
        return { content: JSON.stringify({ dryRun: true, note: `Skipped mutating browser tool ${toolName}` }) };
      }
      const fno = server === 'playwright';
      const autoWait = fno && this.cfg.AGENT_FNO_AUTO_WAIT !== false;
      let res = await this.mcp.callTool(server, toolName, args, this.toolTimeoutMs(toolName, args));
      let text = responseText(res.content);
      // A locator target is resolved at once, without waiting, so it misses controls of a form that is still
      // loading. Nothing was done in that case, so waiting for F&O and trying once more is safe.
      const locatorTarget = fno && typeof args.target === 'string' && !isSnapshotRef(args.target) ? args.target : undefined;
      if (res.isError && locatorTarget && isMissingTarget(text)) {
        if (autoWait) {
          await this.waitForFno();
          res = await this.mcp.callTool(server, toolName, args, this.toolTimeoutMs(toolName, args));
          text = responseText(res.content);
        }
        if (res.isError && ctx.page.key) this.pageMap?.failControl(ctx.page.key, locatorTarget);
      }
      if (autoWait && !res.isError && FNO_SETTLE_TOOLS.has(toolName)) await this.waitForFno();
      const captured = await this.captureBinaryContent(res.content, ctx.artifactsDir);
      ctx.artifacts.push(...captured);
      let content = redactSecrets(this.cfg, fno && this.cfg.AGENT_SLIM_SNAPSHOTS !== false ? slimSnapshot(text) : text);
      if (fno) {
        const problem = detectAuthProblem(text);
        const authStop = problem && ctx.guard.authStop(problem);
        if (authStop) return { content, errored: true, stop: authStop };
        if (toolName === 'browser_navigate' && typeof args.url === 'string' && detectUnreachable(text, Boolean(res.isError))) {
          const stop = ctx.guard.recordUnreachable(args.url, res.isError ? this.clean(mcpErrorText(res.content), 120) : 'the page reported it was not found');
          return {
            content: JSON.stringify({
              error: `${args.url} could not be opened. Do not retry it or look for another route. Report the step as blocked with cause "not_found" and continue with the next step that does not depend on it, or call finish_test.`,
            }),
            errored: true,
            stop,
          };
        }
      }
      if (fno && !res.isError) {
        const line = pathLine(toolName, args);
        if (line) ctx.path.push(this.clean(line, 200));
        if (redactSecrets(this.cfg, text) !== text) ctx.recorder.reject('a secret appeared in a tool result');
        else ctx.recorder.add(toolName, text);
        this.learnFromResult(toolName, args, text, ctx);
        const hint = opts.noHint ? undefined : this.takeHint(ctx);
        if (hint) content += `\n\n${redactSecrets(this.cfg, hint)}`;
      }
      return { content, ...(res.isError ? { errored: true } : {}) };
    } catch (e) {
      if (isTimeoutError(e)) {
        const ms = this.toolTimeoutMs(toolName, args);
        const note = this.clean(`${call.name} exceeded ${Math.round(ms / 1000)}s`, LIMITS.blockNote);
        ctx.timeouts.push(note);
        return {
          errored: true,
          content: JSON.stringify({
            error: `${call.name} timed out after ${Math.round(ms / 1000)}s. The page may still be loading or a dialog may be open: take a fresh browser_snapshot before retrying.`,
          }),
        };
      }
      return { content: redactSecrets(this.cfg, JSON.stringify({ error: (e as Error).message })), errored: true };
    }
  }

  /**
   * Opens a page by menu item through the normal `browser_navigate` path (so the URL and company
   * are policy-checked like any navigation), waits for F&O's busy overlay to clear, and returns a
   * fresh snapshot: one model turn instead of a navigate, a wait and a snapshot.
   */
  private async openMenuItem(
    call: LlmToolCall,
    args: Record<string, unknown>,
    ctx: Parameters<AgentOrchestrator['dispatch']>[1],
  ): Promise<DispatchResult> {
    const fail = (error: string): DispatchResult => ({ content: JSON.stringify({ error }), errored: true });
    if (!this.cfg.D365_BASE_URL || !this.menuItems) return fail('No F&O URL is configured (D365_BASE_URL).');
    const page = typeof args.page === 'string' ? args.page.trim() : '';
    const raw = typeof args.menuItem === 'string' ? args.menuItem.trim() : '';
    let mi: string | undefined;
    let label = raw;
    if (raw) {
      const match = resolveMenuItem(this.menuItems, raw);
      if ('item' in match) ({ mi, label } = match.item);
      else if (isMenuItemName(raw)) mi = raw;
      else return fail(`'${this.clean(raw, 80)}' is not a menu item name (letters, digits and underscores only).`);
    } else if (page) {
      const match = resolveMenuItem(this.menuItems, page);
      if ('item' in match) ({ mi, label } = match.item);
      else {
        const options = match.candidates.map((m) => `${m.label} (${m.mi})`).join('; ');
        return fail(
          options
            ? `'${this.clean(page, 80)}' matches several pages: ${options}. Call again with the right menuItem.`
            : `'${this.clean(page, 80)}' is not a known page. Pass its menu item name as menuItem if you know it, otherwise open it with the navigation search box.`,
        );
      }
    } else {
      return fail('Pass `page` (caption or module path) or `menuItem` (menu item name).');
    }

    const company = ctx.tc.legalEntity ?? this.cfg.D365_COMPANY;
    const url = menuItemUrl(this.cfg.D365_BASE_URL, company, mi!);
    const nav = await this.dispatch({ id: call.id, name: 'playwright__browser_navigate', arguments: { url } }, ctx, { noHint: true });
    if (nav.errored || nav.policyBlocked || nav.stop) return nav;
    try {
      await this.mcp.callTool('playwright', 'browser_wait_for', { textGone: FNO_BUSY_TEXT }, this.cfg.AGENT_NAV_TIMEOUT_MS ?? 60000);
      const snap = await this.mcp.callTool('playwright', 'browser_snapshot', {}, this.cfg.AGENT_TOOL_TIMEOUT_MS ?? 60000);
      if (!snap.isError) {
        const raw = responseText(snap.content);
        this.learnFromResult('browser_snapshot', {}, raw, ctx);
        const text = this.cfg.AGENT_SLIM_SNAPSHOTS !== false ? slimSnapshot(raw) : raw;
        const hint = this.takeHint(ctx);
        return { content: redactSecrets(this.cfg, `Opened ${label} (${mi}) in ${company}.\n${text}${hint ? `\n\n${hint}` : ''}`) };
      }
    } catch {
      // The navigation result below still carries a snapshot; the model can wait and snapshot itself.
    }
    const hint = this.takeHint(ctx);
    return { ...nav, content: `Opened ${label} (${mi}) in ${company}; the page may still be loading.\n${nav.content}${hint ? `\n\n${hint}` : ''}` };
  }

  /**
   * Live learning from a successful browser call: notes which form the browser is on (by the URL's
   * menu item, else the page title) and stores the stable locator each control resolved to under the
   * form it was used on, so the next visit can act on it without a snapshot.
   */
  private learnFromResult(toolName: string, args: Record<string, unknown>, text: string, ctx: Parameters<AgentOrchestrator['dispatch']>[1]): void {
    if (!this.pageMap) return;
    const before = ctx.page.key;
    const info = pageInfo(text);
    const key = pageKey(info);
    if (info && key && key !== before) {
      this.pageMap.visit(info);
      ctx.page.key = key;
    }
    const action = LEARNABLE[toolName];
    const formKey = before ?? key;
    if (!action || !formKey || this.cfg.AGENT_DRY_RUN) return;
    const locators = ranLocators(text);
    if (toolName === 'browser_fill_form') {
      const fields = Array.isArray(args.fields) ? (args.fields as Array<Record<string, unknown>>) : [];
      locators.forEach((loc, i) => this.pageMap!.learnControl(formKey, String(fields[i]?.name ?? ''), loc, action));
    } else if (locators[0]) {
      this.pageMap.learnControl(formKey, typeof args.element === 'string' ? args.element : '', locators[0], action);
    }
  }

  /** The learned hint for the current form, once per form per attempt. */
  private takeHint(ctx: Parameters<AgentOrchestrator['dispatch']>[1]): string | undefined {
    const key = ctx.page.key;
    if (!key || !this.pageMap || ctx.page.hinted.has(key)) return undefined;
    ctx.page.hinted.add(key);
    return this.pageMap.hint(key);
  }

  /** Waits for F&O's blocking overlay to clear. Returns at once when it is not shown. */
  private async waitForFno(): Promise<void> {
    try {
      await this.mcp.callTool('playwright', 'browser_wait_for', { textGone: FNO_BUSY_TEXT }, this.cfg.AGENT_NAV_TIMEOUT_MS ?? 60000);
    } catch {
      // The model sees the page state on its next snapshot.
    }
  }

  private async savePages(): Promise<void> {
    try {
      await this.pageMap?.save();
    } catch (e) {
      console.warn(`[agent] could not save the learned pages: ${(e as Error).message}`);
    }
  }

  /**
   * Feeds the outcome back into the knowledge base: hints offered to a passing run gain credibility, and
   * hints offered to a run that did not pass lose some, but only when the failure is one they could have caused
   * (`hintsMayBeAtFault`). A known-good path is judged the same way, so it stops being offered once it
   * fails repeatedly for such a reason. A likely product defect does not count against it: the route was fine.
   */
  private async learnFromOutcome(tc: TestCase, outcome: StepStatus, category: FailureCategory | undefined, steps: StepResult[], retrieved: KbEntry[], knownPath?: KbEntry): Promise<void> {
    const blamed = hintsMayBeAtFault(category, steps);
    const pathBroken = blamed || steps.some((s) => s.cause === 'not_found');
    const ids = retrieved.map((e) => e.id);
    try {
      let changed = false;
      if (outcome === 'passed') changed = this.kb.recordOutcome(ids, true) > 0 || changed;
      else if (blamed) changed = this.kb.recordOutcome(ids, false) > 0 || changed;
      if (knownPath && pathBroken) changed = this.kb.recordOutcome([knownPath.id], false) > 0 || changed;
      if (changed) await this.kb.save();
    } catch (e) {
      console.warn(`[agent] could not update the knowledge base for ${tc.id}: ${(e as Error).message}`);
    }
  }

  /** A case that failed and then passed on a retry taught the agent something: keep what broke and what worked. */
  private async learnFromRecovery(tc: TestCase, attempts: AttemptResult[]): Promise<void> {
    const lesson = recoveryLesson(tc, attempts);
    if (!lesson) return;
    try {
      this.kb.upsert({
        ...lesson,
        summary: this.clean(lesson.summary, LIMITS.learningSummary),
        details: this.clean(lesson.details, LIMITS.learningDetails),
      });
      await this.kb.save();
    } catch (e) {
      console.warn(`[agent] could not save the recovery lesson for ${tc.id}: ${(e as Error).message}`);
    }
  }

  /** Keeps the Playwright code of a passing attempt so the case can be replayed (and exported) without the AI. */
  private async saveReplay(tc: TestCase, recorder: ReplayRecorder): Promise<void> {
    const { steps, problem } = recorder.result();
    if (!steps.some((s) => s.actions.length || s.assertions.length)) return;
    try {
      const script = await this.replays.record(tc, steps, problem);
      const blocker = replayBlocker(script, tc);
      this.log(blocker ? `recorded the run of ${tc.id}, but it will not be replayed: ${blocker}` : `recorded the run of ${tc.id}; the next run replays it without the AI`);
    } catch (e) {
      console.warn(`[agent] could not save the replay script: ${(e as Error).message}`);
    }
  }

  /**
   * Replays the recorded Playwright code of the case's last passing run, step by step, through Playwright MCP's
   * run-code tool (never offered to the model). Only runs when the recording covers every step and has a recorded
   * check for every expected result, so a replayed pass checked the same things the AI did. Returns undefined when
   * there is nothing to replay; a failed replay leaves the case to the AI.
   */
  private async replay(tc: TestCase, signal?: AbortSignal): Promise<{ attempt?: AttemptResult; info: NonNullable<TestResult['replay']> } | undefined> {
    if (this.cfg.AGENT_REPLAY === false || this.cfg.AGENT_DRY_RUN || !this.mcpServers.includes('playwright') || signal?.aborted) return undefined;
    let script;
    try {
      script = await this.replays.get(tc.id);
    } catch {
      return undefined;
    }
    const blocker = replayBlocker(script, tc);
    if (!script || blocker) {
      if (script && this.cfg.AGENT_VERBOSE) this.log(`not replaying ${tc.id}: ${blocker}`);
      return undefined;
    }
    // The file is on disk and could have been edited: check every line again, and every address against the guardrails.
    const recorded = new Map(script.steps.map((s) => [s.index, s]));
    for (const st of script.steps) {
      for (const code of [...st.actions, ...st.assertions]) {
        const line = parseCodeLine(code);
        const denied = !line ? 'it contains code replay does not run' : line.kind === 'goto' ? this.guardrails.checkCall('playwright', 'browser_navigate', { url: line.url }, tc.legalEntity) : undefined;
        if (denied) {
          this.log(`not replaying ${tc.id}: ${denied}`);
          return undefined;
        }
      }
    }
    const tool = await this.runCodeTool();
    if (!tool) return undefined;

    this.log(`replaying the recorded run of ${tc.id} without the AI`);
    const startedAt = new Date();
    const steps: StepResult[] = [];
    const navMs = this.cfg.AGENT_NAV_TIMEOUT_MS ?? 60000;
    const expectMs = this.cfg.PW_ACTION_TIMEOUT_MS ?? 15000;
    let failure: { step: number; error: string } | undefined;
    for (const tcStep of tc.steps) {
      if (signal?.aborted) {
        failure = { step: tcStep.index, error: INTERRUPTED_MESSAGE };
        break;
      }
      const rec: RecordedStep = recorded.get(tcStep.index)!;
      const began = Date.now();
      const timeout = (rec.actions.length + 1) * navMs + rec.assertions.length * expectMs;
      let error: string | undefined;
      if (rec.actions.length || rec.assertions.length) {
        try {
          const res = await this.mcp.callTool('playwright', tool, { code: stepFunction(rec, { settleMs: navMs, expectMs }) }, timeout);
          if (res.isError) error = mcpErrorText(res.content);
        } catch (e) {
          error = (e as Error).message;
        }
      }
      if (error) {
        failure = { step: tcStep.index, error: this.clean(error.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim(), 500) };
        steps.push({ index: tcStep.index, status: 'failed', errorMessage: failure.error, observed: 'Replay of the recorded run stopped here.', durationMs: Date.now() - began });
        break;
      }
      const checks = rec.assertions.length ? `; checked: ${rec.assertions.map((a) => a.replace(/^await /, '').replace(/;$/, '')).join('; ')}` : '';
      steps.push({
        index: tcStep.index,
        status: 'passed',
        ...(tcStep.expected ? { verified: true } : {}),
        observed: this.clean(`Replayed without the AI: ${rec.actions.length} recorded action(s)${checks}`, LIMITS.observed),
        durationMs: Date.now() - began,
      });
    }
    if (failure?.error !== INTERRUPTED_MESSAGE) await this.replays.recordOutcome(tc.id, !failure).catch(() => undefined);

    const finishedAt = new Date();
    if (failure) {
      this.log(`replay of ${tc.id} failed at step ${failure.step}; running it with the AI`);
      return { info: { outcome: 'failed', step: failure.step, error: failure.error } };
    }
    return {
      info: { outcome: 'passed' },
      attempt: {
        outcome: 'passed',
        runState: 'completed',
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        steps,
        artifacts: [],
        learnings: [],
        policyBlocks: [],
        timeouts: [],
        data: {},
      },
    };
  }

  /** Playwright MCP's run-code tool (named browser_run_code in older versions), if the server has it. */
  private async runCodeTool(): Promise<string | undefined> {
    let tools = this.toolCache.get('playwright');
    if (!tools) {
      try {
        tools = await this.mcp.listTools('playwright');
        this.toolCache.set('playwright', tools);
      } catch {
        return undefined;
      }
    }
    return ['browser_run_code_unsafe', 'browser_run_code'].find((n) => tools!.some((t) => t.name === n));
  }

  /** Saves the UI actions of a passing attempt as the test case's known-good path, replacing the previous one. */
  private async saveKnownPath(tc: TestCase, path: string[]): Promise<void> {
    const lines = path.length > MAX_PATH_LINES ? [...path.slice(0, MAX_PATH_LINES), `… ${path.length - MAX_PATH_LINES} more actions`] : path;
    try {
      this.kb.upsert({
        kind: 'recipe',
        summary: knownPathSummary(tc.id),
        details: this.clean(lines.join('\n'), LIMITS.learningDetails * 2),
        module: tc.module,
        testCaseId: tc.id,
        tags: tc.tags ?? [],
        successCount: 1,
      });
      await this.kb.save();
    } catch (e) {
      console.warn(`[agent] could not save the known-good path: ${(e as Error).message}`);
    }
  }

  /** Time budget for one tool call: navigation gets the longer budget, and an explicit wait is never cut short. */
  private toolTimeoutMs(tool: string, args: Record<string, unknown>): number {
    const base = tool === 'browser_navigate' ? this.cfg.AGENT_NAV_TIMEOUT_MS : this.cfg.AGENT_TOOL_TIMEOUT_MS;
    const budget = base ?? 60000;
    return tool === 'browser_wait_for' && typeof args.time === 'number' ? Math.max(budget, args.time * 1000 + 5000) : budget;
  }

  /** Model-written text is stored in reports and the knowledge base: scrub secrets and cap its size first. */
  private clean(text: string, max: number): string {
    const redacted = redactSecrets(this.cfg, text);
    return redacted.length > max ? `${redacted.slice(0, max)}… [truncated]` : redacted;
  }

  /** One-line, truncated, secret-free progress output so a stuck run is visible. */
  private log(line: string): void {
    const clean = redactSecrets(this.cfg, line).replace(/\s+/g, ' ');
    console.log(`[agent] ${clean.length > 300 ? `${clean.slice(0, 300)}…` : clean}`);
  }

  private async captureBinaryContent(content: unknown, dir: string): Promise<string[]> {
    const paths: string[] = [];
    const parts = Array.isArray(content) ? content : [];
    for (const p of parts) {
      if (p && typeof p === 'object' && (p as { type?: string }).type === 'image') {
        const rec = p as { data?: string; mimeType?: string };
        if (rec.data) {
          const ext = (rec.mimeType ?? 'image/png').split('/')[1] ?? 'png';
          const file = join(dir, `screenshot_${Date.now()}_${paths.length}.${ext}`);
          await writeFile(file, Buffer.from(rec.data, 'base64'));
          paths.push(file);
        }
      }
    }
    return paths;
  }
}

function shouldRetry(outcome: StepStatus, retryOn: StepStatus[], attempt: number, maxAttempts: number): boolean {
  return retryOn.includes(outcome) && attempt < maxAttempts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Browser tools that change state in the app under test. Navigation and snapshots are
 * deliberately not listed: in a dry run they must still execute so the model can see a page
 * (e.g. reach the login screen) instead of looping on a skipped navigate.
 */
/**
 * One line of a known-good path for a successful browser action. Element descriptions are kept
 * (refs change on every page load) and typed values are not: they come from the test steps or the run.
 */
function pathLine(tool: string, args: Record<string, unknown>): string | undefined {
  const el = typeof args.element === 'string' && args.element.trim() ? `"${args.element.trim()}"` : 'an element';
  switch (tool) {
    case 'browser_navigate':
      return typeof args.url === 'string' ? `open ${args.url}` : undefined;
    case 'browser_click':
      return `${args.doubleClick ? 'double-click' : 'click'} ${el}`;
    case 'browser_type':
      return `type into ${el}${args.submit ? ' and press Enter' : ''}`;
    case 'browser_select_option':
      return `select an option in ${el}`;
    case 'browser_press_key':
      return typeof args.key === 'string' ? `press ${args.key}` : undefined;
    case 'browser_hover':
      return `hover ${el}`;
    case 'browser_handle_dialog':
      return `${args.accept ? 'accept' : 'dismiss'} the dialog`;
    case 'browser_fill_form': {
      const fields = Array.isArray(args.fields) ? args.fields : [];
      const names = fields.map((f) => (f && typeof f === 'object' ? String((f as { name?: unknown }).name ?? '') : '')).filter(Boolean);
      return `fill form fields ${names.map((n) => `"${n}"`).join(', ') || '(unnamed)'}`;
    }
    default:
      return undefined;
  }
}

function isMutatingBrowserTool(name: string): boolean {
  return /(click|type|fill|drag|drop|press|upload|handle_dialog|select_option|evaluate|run_code|route|_set|_delete|_clear)/i.test(name);
}

function isTimeoutError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown };
  return err?.code === -32001 || /request timed out|timed out/i.test(String(err?.message ?? ''));
}

/** Free-text query for knowledge-base retrieval: what the case is about and what its steps do. */
export function retrievalQuery(tc: TestCase): string {
  const steps = tc.steps.map((s) => `${s.action} ${s.expected ?? ''}`).join(' ');
  return `${tc.title} ${tc.module ?? ''} ${tc.area ?? ''} ${tc.tags?.join(' ') ?? ''} ${steps}`.slice(0, 4000);
}

/**
 * A short account of why the previous attempt did not pass, given to the next attempt so it does not repeat
 * the same mistake (reflexion). Only facts the run recorded; the model decides what to change.
 */
export function reflectOn(previous: Pick<AttemptResult, 'outcome' | 'errorMessage' | 'steps' | 'policyBlocks' | 'timeouts'>, knownPath?: KbEntry): string {
  const lines = [`The previous attempt ended ${previous.outcome}.`];
  if (previous.errorMessage) lines.push(`Reason: ${previous.errorMessage.replace(/\s+/g, ' ').slice(0, 500)}`);
  const passed = previous.steps.filter((s) => s.status === 'passed').map((s) => s.index);
  if (passed.length) lines.push(`Steps that passed: ${passed.join(', ')}. Data they created may already exist; check before creating it again.`);
  for (const s of previous.steps.filter((x) => x.status === 'failed' || x.status === 'blocked').slice(0, 5)) {
    const detail = (s.errorMessage ?? s.observed ?? '').replace(/\s+/g, ' ').slice(0, 300);
    lines.push(`Step ${s.index} ${s.status}${s.cause ? ` (${s.cause})` : ''}${detail ? `: ${detail}` : ''}`);
  }
  if (previous.policyBlocks.length) lines.push(`Refused by policy: ${previous.policyBlocks.slice(0, 3).join('; ')}`);
  if (previous.timeouts.length) lines.push(`Timed out: ${previous.timeouts.slice(0, 3).join('; ')}`);
  if (knownPath) lines.push('The known-good path below was offered last time too; if it led to the failure, work the step out from the page instead.');
  lines.push('Take a fresh snapshot, start from a clean page, and try a different approach where the last one went wrong.');
  return lines.join('\n');
}

/**
 * What a recovered test teaches: where the first failing attempt went wrong and the route that then worked.
 * Built only from what the runs recorded, so it needs no model call. Undefined when nothing useful was recorded.
 */
export function recoveryLesson(tc: TestCase, attempts: Array<Pick<AttemptResult, 'outcome' | 'errorMessage' | 'steps' | 'path'>>): KbEntryInput | undefined {
  const final = attempts.at(-1);
  const failed = attempts.slice(0, -1).find((a) => a.outcome === 'failed' || a.outcome === 'blocked');
  const worked = (final?.path ?? []).filter((l) => !l.startsWith('-- '));
  if (!final || final.outcome !== 'passed' || !failed || !worked.length) return undefined;
  const bad = failed.steps.find((s) => s.status === 'failed' || s.status === 'blocked');
  const what = (bad?.errorMessage ?? bad?.observed ?? failed.errorMessage ?? '').replace(/\s+/g, ' ').slice(0, 300);
  const lines = [
    `Test case ${tc.id} (${tc.title}) failed at first${bad ? ` on step ${bad.index}${bad.cause ? ` (${bad.cause})` : ''}` : ''}${what ? `: ${what}` : ''}.`,
    'A later attempt passed by doing this:',
    ...worked.slice(0, MAX_PATH_LINES),
  ];
  return {
    kind: 'remediation',
    summary: `Recovered ${tc.id}${bad ? ` after step ${bad.index} ${bad.status}` : ''}: ${tc.title}`,
    details: lines.join('\n'),
    module: tc.module,
    testCaseId: tc.id,
    tags: [...(tc.tags ?? []), 'self-healed'],
    successCount: 1,
  };
}

/** Steps with an expected result that were not both reported as passed and marked verified (or not reported at all). */
export function unverifiedSteps(tc: TestCase, steps: StepResult[]): number[] {
  return tc.steps
    .filter((t) => t.expected)
    .filter((t) => {
      const r = steps.find((s) => s.index === t.index);
      if (!r) return true;
      return r.status === 'passed' && r.verified !== true;
    })
    .map((t) => t.index);
}
