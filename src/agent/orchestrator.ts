import { mkdir, writeFile } from 'node:fs/promises';
import { finishTrace, snapshotFiles, traceOutputDir, tracingEnabled } from '../mcp/playwright-trace.js';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppConfig } from '../config/index.js';
import type { LlmProvider } from '../llm/index.js';
import type { LlmMessage, LlmTool, LlmToolCall } from '../llm/types.js';
import type { McpManager, McpToolDescriptor } from '../mcp/manager.js';
import { mergeMenuItems, PageMap, pageKey, type ControlAction } from '../knowledge/page-map.js';
import { isFnoLoading, isMissingTarget, isSnapshotRef, pageInfo, ranLocators, responseText, slimSnapshot, withoutSnapshot } from '../mcp/playwright-response.js';
import type { CaseUsage, RunState, StepCause, StepResult, StepStatus, TestCase, TestResult } from '../testing/types.js';
import { classifyFailure } from '../testing/triage.js';
import { CREDENTIAL_TOOL, CREDENTIAL_TOOL_NAME, credentialEntryCode, credentialFor, mcpErrorText, redactSecrets } from '../d365fo/login.js';
import { isMenuItemName, loadMenuItems, menuItemUrl, openMenuItemTool, OPEN_MENU_ITEM_TOOL_NAME, resolveMenuItem, type MenuItem } from '../d365fo/navigation.js';
import { baseSystemPrompt, testCaseUserPrompt } from './prompts.js';
import { compactHistory } from './context.js';
import { Guardrails } from './guardrails.js';
import { toUnavailable } from '../llm/errors.js';
import { AttemptGuard, destructiveClick, detectAuthProblem, detectUnreachable, type RunStop } from './run-guard.js';

const DEFAULT_MAX_REPEATED_CALLS = 3;
const DEFAULT_CONTEXT_KEEP_RECENT = 3;
/** An attempt that keeps hitting the guardrails is stopped instead of probing for a way around them. */
const MAX_POLICY_BLOCKS = 5;
const STEP_STATUSES: readonly StepStatus[] = ['passed', 'failed', 'skipped', 'blocked'];
const STEP_CAUSES: readonly StepCause[] = ['not_found', 'no_access', 'sign_in', 'missing_data', 'other'];
const MAX_DATA_KEYS = 20;
/** Text F&O shows on its blocking overlay while a form loads or a request is processed. */
const FNO_BUSY_TEXT = 'Please wait';
/** Model turns a long case gets per test step when that is more than AGENT_MAX_STEPS: a step takes a few calls (act, snapshot, check, report). */
const TURNS_PER_STEP = 4;
/** How often a page still on the F&O splash is checked, and the longest wait before it is reloaded once. */
const SPLASH_POLL_MS = 1000;
const SPLASH_RELOAD_AFTER_MS = 30000;
const LIMITS = { dataKey: 60, dataValue: 500, observed: 2000, error: 2000, summary: 1000, blockNote: 300 };

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
          enum: ['not_found', 'no_access', 'sign_in', 'missing_data', 'other'],
          description:
            'Why a failed or blocked step could not be done. not_found: a page, menu item, path or record named in the test case does not exist. no_access: the user lacks permission. sign_in: sign-in needs MFA or was refused. missing_data: the test case leaves a value it needs unset (a TBC placeholder for existing data or setup). These stop pointless retries.',
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
      'Save a value created or discovered during this run (a generated vendor account, an order number) so later steps of this case and the report can use it. Never store secrets. Use `recall_values` to read them back.',
    inputSchema: {
      type: 'object',
      required: ['key', 'value'],
      properties: { key: { type: 'string' }, value: { type: 'string' } },
    },
  },
  {
    name: 'recall_values',
    description:
      'Return every value saved with record_value in this test case.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'finish_test',
    description: 'End the test case with an overall verdict and summary.',
    inputSchema: {
      type: 'object',
      required: ['outcome'],
      properties: {
        outcome: { type: 'string', enum: ['passed', 'failed', 'skipped', 'blocked'] },
        summary: { type: 'string' },
        errorMessage: { type: 'string' },

      },
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
  usage: CaseUsage;
  errorMessage?: string;
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
  private mcpServers: string[];
  private guardrails: Guardrails;
  private reportedHiddenTools = false;
  private menuItems?: MenuItem[];
  private pageMap?: PageMap;
  /** MCP tool lists do not change during a run; listing them once saves a round trip per attempt. */
  private toolCache = new Map<string, McpToolDescriptor[]>();

  constructor(opts: RunOptions) {
    this.cfg = opts.cfg;
    this.llm = opts.llm;
    this.mcp = opts.mcp;
    this.mcpServers = opts.mcpServers;
    this.guardrails = new Guardrails(opts.cfg, opts.mcpServers);
  }

  /** Cancellation stops in-flight requests and prevents dispatching any subsequent action. */
  async runTestCase(tc: TestCase, signal?: AbortSignal): Promise<TestResult> {
    const startedAt = new Date().toISOString();
    let result: AttemptResult;
    try {
      result = await this.runAttempt(tc, signal);
    } catch (e) {
      if (!signal?.aborted) throw e;
      result = {
        interrupted: true, outcome: 'blocked', runState: 'blocked', startedAt, finishedAt: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(startedAt), steps: [], artifacts: [], learnings: [], policyBlocks: [], timeouts: [], data: {},
        usage: { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelMs: 0 }, errorMessage: INTERRUPTED_MESSAGE,
      };
    }
    const category = classifyFailure(result);
    return {
      ...result, testCaseId: tc.id, title: tc.title,
      ...(category ? { failureCategory: category } : {}),
      ...(result.policyBlocks.length ? {} : { policyBlocks: undefined }),
      ...(result.timeouts.length ? {} : { timeouts: undefined }),
      attemptCount: 1,
    };
  }

  private async runAttempt(tc: TestCase, signal?: AbortSignal): Promise<AttemptResult> {
    signal?.throwIfAborted();
    const startedAt = new Date();
    const artifactsDir = join(this.cfg.REPORT_DIR, 'artifacts', tc.id);
    await mkdir(artifactsDir, { recursive: true });
    signal?.throwIfAborted();

    const mcpTools: McpToolDescriptor[] = [];
    for (const server of this.mcpServers) {
      try {
        let tools = this.toolCache.get(server);
        if (!tools) {
          tools = await withCancellation(signal, () => this.mcp.listTools(server, signal));
          this.toolCache.set(server, tools);
        }
        mcpTools.push(...tools);
      } catch (e) {
        signal?.throwIfAborted();
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
        this.pageMap = await withCancellation(signal, () => PageMap.load(this.cfg.KB_DIR ?? './knowledge'));
      } catch (e) {
        signal?.throwIfAborted();
        console.warn(`[agent] page learning is off for this run: ${(e as Error).message}`);
      }
    }
    // Reloaded per case, so forms learned by earlier cases of this run can be opened by caption.
    if (canOpenPages) this.menuItems = mergeMenuItems(await withCancellation(signal, () => loadMenuItems(this.cfg.KB_DIR ?? './knowledge')), this.pageMap?.menuItems() ?? []);
    const tools: LlmTool[] = [
      ...allowedTools.map((t) => ({
        name: `${t.server}__${t.name}`,
        description: `[${t.server}] ${t.description}`,
        inputSchema: t.inputSchema,
      })),
      ...LOCAL_TOOLS,
      CREDENTIAL_TOOL,
      ...(canOpenPages && this.menuItems ? [openMenuItemTool(this.menuItems)] : []),
      ...(this.pageMap ? [PAGE_NOTE_TOOL] : []),
    ];

    let traceBefore: Set<string> | undefined;
    if (tracingEnabled(this.cfg) && this.mcpServers.includes('playwright')) {
      try {
        traceBefore = await withCancellation(signal, () => snapshotFiles(traceOutputDir(this.cfg)));
        await this.callMcp('playwright', 'browser_start_tracing', {}, this.cfg.AGENT_TOOL_TIMEOUT_MS, signal);
      } catch (e) {
        signal?.throwIfAborted();
        traceBefore = undefined;
        console.warn(`[agent] could not start a Playwright trace (${(e as Error).message}); continuing without one`);
      }
    }

    const messages: LlmMessage[] = [{ role: 'user', content: testCaseUserPrompt(tc) }];
    const steps: StepResult[] = [];
    const learnings: string[] = [];
    const artifacts: string[] = [];
    const policyBlocks: string[] = [];
    const timeouts: string[] = [];
    const data: Record<string, string> = {};
    const page = { key: undefined as string | undefined, hinted: new Set<string>() };
    let outcome: StepStatus = 'blocked';
    let overallError: string | undefined;
    let stopped = false;
    const maxRepeats = this.cfg.AGENT_MAX_REPEATED_CALLS ?? DEFAULT_MAX_REPEATED_CALLS;
    let lastCallKey: string | undefined;
    let repeats = 0;
    const guard = new AttemptGuard(this.cfg);
    const maxTurns = turnBudget(this.cfg.AGENT_MAX_STEPS, tc.steps.length);
    let turns = 0;
    let finished = false;
    const usage: CaseUsage = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelMs: 0 };

    try {
      for (let iter = 0; iter < maxTurns && !stopped && !signal?.aborted; iter++) {
        turns = iter + 1;
        const compacted = compactHistory(messages, this.cfg.AGENT_CONTEXT_KEEP_RECENT ?? DEFAULT_CONTEXT_KEEP_RECENT);
        if (this.cfg.AGENT_VERBOSE && compacted > 0) this.log(`context: collapsed ${compacted} older tool result(s)`);
        const overBudget = guard.checkBudgets();
        if (overBudget) {
          outcome = 'blocked';
          overallError = overBudget.message;
          break;
        }
        const askedAt = Date.now();
        const response = await withCancellation(signal, () => this.llm.complete({
          system: baseSystemPrompt(this.cfg),
          messages,
          tools,
          signal,
        }));
        usage.modelMs += Date.now() - askedAt;
        usage.turns++;
        usage.inputTokens += response.usage?.inputTokens ?? 0;
        usage.outputTokens += response.usage?.outputTokens ?? 0;
        usage.cacheReadTokens += response.usage?.cacheReadTokens ?? 0;
        usage.cacheWriteTokens += response.usage?.cacheWriteTokens ?? 0;
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
          signal?.throwIfAborted();
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
            guard,
            page,
            signal,
          });
          signal?.throwIfAborted();
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
            break;
          } else if (stop) {
            outcome = 'blocked';
            overallError = stop.message;
            stopped = true;
            break;
          } else if (dispatched.policyBlocked && policyBlocks.length >= MAX_POLICY_BLOCKS) {
            outcome = 'blocked';
            overallError = `Agent stopped: ${policyBlocks.length} tool calls were refused by the guardrails (e.g. ${policyBlocks[0]}). The run was steered outside its permitted scope.`;
            stopped = true;
            break;
          }
        }

        if (response.stopReason === 'end_turn' && !stopped) {
          finished = true;
          break;
        }
      }
      // The loop ran out of turns with the model still working: say so instead of "ended without a reason".
      if (!stopped && !finished && !overallError && turns >= maxTurns && !signal?.aborted) {
        const reported = new Set(steps.map((s) => s.index));
        const left = tc.steps.map((s) => s.index).filter((i) => !reported.has(i));
        overallError = `Agent stopped: the test used all ${maxTurns} model turns (AGENT_MAX_STEPS) before it finished${left.length ? `; step ${left.join(', ')} ${left.length > 1 ? 'were' : 'was'} not reported` : ''}. Raise AGENT_MAX_STEPS for long cases, or split the case.`;
      }
    } catch (e) {
      const unavailable = signal?.aborted ? undefined : toUnavailable(e);
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
      const verdict = verifiedCaseVerdict(tc, steps);
      outcome = verdict.outcome;
      overallError = verdict.errorMessage;
    }

    if (!signal?.aborted) await this.savePages();

    if (traceBefore && !signal?.aborted) {
      try {
        await this.callMcp('playwright', 'browser_stop_tracing', {}, this.cfg.AGENT_TOOL_TIMEOUT_MS, signal);
        artifacts.push(...(await withCancellation(signal, () => finishTrace(this.cfg, traceBefore!, outcome))));
      } catch (e) {
        console.warn(`[agent] could not finish the Playwright trace: ${(e as Error).message}`);
      }
    }

    const finishedAt = new Date();
    if (signal?.aborted) {
      outcome = 'blocked';
      overallError = INTERRUPTED_MESSAGE;
    }
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
      usage,
      ...(signal?.aborted ? { interrupted: true } : {}),
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
      guard: AttemptGuard;
      /** The F&O form the browser is on, and the forms whose learned hints were already shown this attempt. */
      page: { key?: string; hinted: Set<string> };
      signal?: AbortSignal;
    },
    opts: { noHint?: boolean } = {},
  ): Promise<DispatchResult> {
    ctx.signal?.throwIfAborted();
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
      if (args.status === 'failed' || args.status === 'blocked') {
        if (args.cause === 'sign_in') {
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
    if (call.name === 'recall_values') {
      return { content: JSON.stringify(ctx.data) };
    }
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
      if (!this.mcpServers.includes('playwright') || !this.toolCache.get('playwright')?.some((t) => t.name === 'browser_run_code')) {
        return fail('Credential entry refused: this browser does not support trusted authentication checks. Sign in with a saved browser session.');
      }
      try {
        const res = await this.callMcp(
          'playwright',
          'browser_run_code',
          { code: credentialEntryCode(field as 'username' | 'password', secret, args.submit === true) },
          this.cfg.AGENT_TOOL_TIMEOUT_MS,
          ctx.signal,
        );
        const body = res.isError
          ? { error: `The credential was configured, but typing it failed: ${mcpErrorText(res.content)}` }
          : { ok: true, entered: args.field };
        return { content: redactSecrets(this.cfg, JSON.stringify(body)) };
      } catch (e) {
        ctx.signal?.throwIfAborted();
        return { content: redactSecrets(this.cfg, JSON.stringify({ error: `Typing the credential failed: ${(e as Error).message}` })) };
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
      ctx.signal?.throwIfAborted();
      return { content: JSON.stringify({ ok: true, savedFor: ctx.page.key }) };
    }
    if (call.name === 'finish_test') {
      if (!STEP_STATUSES.includes(args.outcome as StepStatus)) {
        return fail(`Invalid outcome ${JSON.stringify(args.outcome)}. Use one of: ${STEP_STATUSES.join(', ')}. The test is still open; call finish_test again.`);
      }
      const outcome = args.outcome as StepStatus;
      const errorMessage = typeof args.errorMessage === 'string' ? this.clean(args.errorMessage, LIMITS.error) : undefined;
      const summary = typeof args.summary === 'string' ? this.clean(args.summary, LIMITS.summary) : '';
      if (summary) ctx.learnings.push(summary);
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
      let res = await this.callMcp(server, toolName, args, this.toolTimeoutMs(toolName, args), ctx.signal);
      let text = responseText(res.content);
      // A locator target is resolved at once, without waiting, so it misses controls of a form that is still
      // loading. Nothing was done in that case, so waiting for F&O and trying once more is safe.
      const locatorTarget = fno && typeof args.target === 'string' && !isSnapshotRef(args.target) ? args.target : undefined;
      if (res.isError && locatorTarget && isMissingTarget(text)) {
        if (autoWait) {
          await this.waitForFno(ctx.signal);
          res = await this.callMcp(server, toolName, args, this.toolTimeoutMs(toolName, args), ctx.signal);
          text = responseText(res.content);
        }
        if (res.isError && ctx.page.key) this.pageMap?.failControl(ctx.page.key, locatorTarget);
      }
      if (autoWait && !res.isError && FNO_SETTLE_TOOLS.has(toolName)) await this.waitForFno(ctx.signal);
      // A page load leaves F&O on its splash for a while: wait it out here rather than leave the model to
      // spend turns on waits and snapshots, or navigate again because the page looks stuck.
      const loaded = autoWait && !res.isError && toolName !== 'browser_wait_for' ? await this.waitPastSplash(text, ctx.signal) : undefined;
      ctx.signal?.throwIfAborted();
      const captured = await this.captureBinaryContent(res.content, ctx.artifactsDir);
      ctx.signal?.throwIfAborted();
      ctx.artifacts.push(...captured);
      // When the page finished loading, the first snapshot only shows the splash: the loaded one below replaces it.
      const shown = loaded ? withoutSnapshot(text) : text;
      let content = redactSecrets(this.cfg, fno && this.cfg.AGENT_SLIM_SNAPSHOTS !== false ? slimSnapshot(shown) : shown);
      if (loaded) {
        content += `\n\nThe page then finished loading:\n${redactSecrets(this.cfg, this.cfg.AGENT_SLIM_SNAPSHOTS !== false ? slimSnapshot(loaded) : loaded)}`;
      } else if (loaded === null) {
        content += `\n\nThe page was still on the F&O loading screen after ${Math.round((this.cfg.AGENT_NAV_TIMEOUT_MS ?? 60000) / 1000)}s, also after one reload.`;
      }
      if (fno) {
        const problem = detectAuthProblem(loaded || text);
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
        this.learnFromResult(toolName, args, text, ctx);
        if (loaded) this.learnFromResult('browser_snapshot', {}, loaded, ctx);
        const hint = opts.noHint ? undefined : this.takeHint(ctx);
        if (hint) content += `\n\n${redactSecrets(this.cfg, hint)}`;
      }
      return { content, ...(res.isError ? { errored: true } : {}) };
    } catch (e) {
      ctx.signal?.throwIfAborted();
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
      await this.callMcp('playwright', 'browser_wait_for', { textGone: FNO_BUSY_TEXT }, this.cfg.AGENT_NAV_TIMEOUT_MS ?? 60000, ctx.signal);
      const snap = await this.callMcp('playwright', 'browser_snapshot', {}, this.cfg.AGENT_TOOL_TIMEOUT_MS ?? 60000, ctx.signal);
      if (!snap.isError) {
        const raw = responseText(snap.content);
        this.learnFromResult('browser_snapshot', {}, raw, ctx);
        const text = this.cfg.AGENT_SLIM_SNAPSHOTS !== false ? slimSnapshot(raw) : raw;
        const hint = this.takeHint(ctx);
        return { content: redactSecrets(this.cfg, `Opened ${label} (${mi}) in ${company}.\n${text}${hint ? `\n\n${hint}` : ''}`) };
      }
    } catch {
      ctx.signal?.throwIfAborted();
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

  /**
   * When `text` shows the F&O splash, waits until the client has loaded (reloading once if it hangs, which is what
   * unstuck it by hand) and returns the loaded page's snapshot; null when it never loaded, undefined when the page
   * was not on the splash.
   */
  private async waitPastSplash(text: string, signal?: AbortSignal): Promise<string | null | undefined> {
    signal?.throwIfAborted();
    if (!isFnoLoading(text, this.cfg.D365_BASE_URL)) return undefined;
    const budget = this.cfg.AGENT_NAV_TIMEOUT_MS ?? 60000;
    const timeout = this.cfg.AGENT_TOOL_TIMEOUT_MS ?? 60000;
    const started = Date.now();
    let reloaded = false;
    try {
      while (Date.now() - started < budget) {
        await delay(SPLASH_POLL_MS, undefined, { signal });
        if (!this.cfg.AGENT_DRY_RUN && !reloaded && Date.now() - started >= Math.min(budget / 2, SPLASH_RELOAD_AFTER_MS)) {
          reloaded = true;
          await this.callMcp('playwright', 'browser_press_key', { key: 'F5' }, timeout, signal);
          continue;
        }
        const snap = await this.callMcp('playwright', 'browser_snapshot', {}, timeout, signal);
        const raw = responseText(snap.content);
        if (snap.isError || isFnoLoading(raw, this.cfg.D365_BASE_URL)) continue;
        await this.waitForFno(signal);
        const settled = await this.callMcp('playwright', 'browser_snapshot', {}, timeout, signal);
        return settled.isError ? raw : responseText(settled.content);
      }
    } catch {
      signal?.throwIfAborted();
      // The model sees the page state on its next snapshot.
      return undefined;
    }
    return null;
  }

  /** Waits for F&O's blocking overlay to clear. Returns at once when it is not shown. */
  private async waitForFno(signal?: AbortSignal): Promise<void> {
    try {
      await this.callMcp('playwright', 'browser_wait_for', { textGone: FNO_BUSY_TEXT }, this.cfg.AGENT_NAV_TIMEOUT_MS ?? 60000, signal);
    } catch {
      signal?.throwIfAborted();
      // The model sees the page state on its next snapshot.
    }
  }

  private callMcp(server: string, tool: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<{ content: unknown; isError: boolean }> {
    return withCancellation(signal, () => this.mcp.callTool(server, tool, args, timeoutMs, signal));
  }

  private async savePages(): Promise<void> {
    try {
      await this.pageMap?.save();
    } catch (e) {
      console.warn(`[agent] could not save the learned pages: ${(e as Error).message}`);
    }
  }

  /** Time budget for one tool call: navigation gets the longer budget, and an explicit wait is never cut short. */
  private toolTimeoutMs(tool: string, args: Record<string, unknown>): number {
    const base = tool === 'browser_navigate' ? this.cfg.AGENT_NAV_TIMEOUT_MS : this.cfg.AGENT_TOOL_TIMEOUT_MS;
    const budget = base ?? 60000;
    return tool === 'browser_wait_for' && typeof args.time === 'number' ? Math.max(budget, args.time * 1000 + 5000) : budget;
  }

  /** Model-written text is stored in reports: scrub secrets and cap its size first. */
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

/** AGENT_MAX_STEPS, or more for a case long enough to need it. */
export function turnBudget(maxSteps: number, stepCount: number): number {
  return Math.max(maxSteps, stepCount * TURNS_PER_STEP);
}

/** Also bounds fake/third-party providers that do not themselves honor AbortSignal. */
function withCancellation<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return run();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }).then(
      (value) => { signal.removeEventListener('abort', abort); signal.aborted ? reject(signal.reason) : resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

function isMutatingBrowserTool(name: string): boolean {
  return /(click|type|fill|drag|drop|press|upload|handle_dialog|select_option|evaluate|run_code|route|_set|_delete|_clear)/i.test(name);
}

function isTimeoutError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown };
  return err?.code === -32001 || /request timed out|timed out/i.test(String(err?.message ?? ''));
}

/** Steps with an expected result that were not both reported as passed and marked verified (or not reported at all). */
export function unverifiedSteps(tc: TestCase, steps: StepResult[]): number[] {
  return tc.steps
    .filter((t) => t.expected)
    .filter((t) => {
      const r = steps.find((s) => s.index === t.index);
      if (!r) return true;
      return r.status !== 'passed' || r.verified !== true;
    })
    .map((t) => t.index);
}

/** The model cannot declare a pass that contradicts the recorded required steps. */
export function verifiedCaseVerdict(tc: TestCase, steps: StepResult[]): { outcome: StepStatus; errorMessage?: string } {
  const failed = steps.filter((s) => s.status === 'failed');
  if (failed.length) return { outcome: 'failed', errorMessage: `Not counted as passed: step ${failed.map((s) => s.index).join(', ')} failed.` };
  const incomplete = tc.steps.filter((s) => steps.find((r) => r.index === s.index)?.status !== 'passed');
  if (!tc.steps.length || incomplete.length) return {
    outcome: 'blocked', errorMessage: `Not counted as passed: ${tc.steps.length ? `required step ${incomplete.map((s) => s.index).join(', ')} was not completed as passed` : 'the case has no required steps'}.`,
  };
  const unverified = unverifiedSteps(tc, steps);
  if (unverified.length) return { outcome: 'blocked', errorMessage: `Not counted as passed: step ${unverified.join(', ')} has an expected result that was not verified against the page.` };
  return { outcome: 'passed' };
}
