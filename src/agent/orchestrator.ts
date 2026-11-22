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
import { fillFromErpEnabled, ODATA_TOOL_NAME, ODataClient, odataEnabled, odataTool, RECORD_PARAMETER_TOOL, RECORD_PARAMETER_TOOL_NAME } from '../d365fo/odata.js';
import { ODataSignInError } from '../d365fo/odata-auth.js';
import { baseSystemPrompt, testCaseUserPrompt } from './prompts.js';
import { compactHistory } from './context.js';
import { Guardrails } from './guardrails.js';
import { toUnavailable } from '../llm/errors.js';
import { AttemptGuard, destructiveClick, detectAuthProblem, detectUnreachable, type RunStop } from './run-guard.js';
import { describeMissing, findPlaceholders, isDescriptive, placeholderKey, placeholdersByStep, preflightCase, preflightSteps, splitMissing, type Placeholder, type PreflightReport } from './preflight.js';
import { appendRecording, beginRecordingStep, captureExpression, captureToolCode, extractPlaywrightCode, finishRecordingStep, newRecording, RECORDABLE_BROWSER_TOOLS, recordingStep, validCaptureRequest, type RecordingState } from '../replay/recording.js';
import { replayProjectConfig, writeSpec } from '../replay/spec.js';
import { valuesForRow } from '../devops/parameters.js';
import { iterationCount } from '../core/iterations.js';

const DEFAULT_MAX_REPEATED_CALLS = 3;
const DEFAULT_CONTEXT_KEEP_RECENT = 3;
/** An attempt that keeps hitting the guardrails is stopped instead of probing for a way around them. */
const MAX_POLICY_BLOCKS = 5;
const STEP_STATUSES: readonly StepStatus[] = ['passed', 'failed', 'skipped', 'blocked'];
const STEP_CAUSES: readonly StepCause[] = ['not_found', 'no_access', 'sign_in', 'missing_data', 'other'];
/** A blocked step with one of these causes makes a later failure a likely consequence, not a defect of its own. */
const DEPENDENCY_CAUSES: ReadonlySet<StepCause> = new Set(['missing_data', 'not_found', 'no_access']);
const MAX_DATA_KEYS = 20;
/** Text F&O shows on its blocking overlay while a form loads or a request is processed. */
const FNO_BUSY_TEXT = 'Please wait';
/** Model turns a long case gets per test step when that is more than AGENT_MAX_STEPS: a step takes a few calls (act, snapshot, check, report). */
const TURNS_PER_STEP = 4;
/** How often a page still on the F&O splash is checked, and the longest wait before it is reloaded once. */
const SPLASH_POLL_MS = 1000;
const SPLASH_RELOAD_AFTER_MS = 30000;
/**
 * F&O shortcuts (learn.microsoft.com, "Keyboard shortcuts"): Ctrl+Shift+F5 reverts the record (also a new, unsaved
 * grid row), then Alt+Shift+Q closes the page discarding any unsaved changes. Never Esc or Back: a plain close may save.
 */
const DISCARD_KEYS = ['Control+Shift+F5', 'Alt+Shift+Q'];
const DISCARD_TIMEOUT_MS = 10000;
const LIMITS = { dataKey: 60, dataValue: 500, observed: 2000, error: 2000, summary: 1000, blockNote: 300 };

const STEP_VERDICT_PROPERTIES = {
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
  independent: {
    type: 'boolean',
    description:
      'For a failed step after an earlier step was blocked: true only if this failure is a product defect of its own, not a consequence of the blocked step (a record that was never saved cannot be found). Without it, such a failure is recorded as blocked.',
  },
};

const LOCAL_TOOLS: LlmTool[] = [
  {
    name: 'begin_step',
    description: 'Mark the 1-based test step you are starting. Successful allowlisted Playwright calls that follow are recorded under this step for optional standalone replay.',
    inputSchema: { type: 'object', required: ['index'], properties: { index: { type: 'integer', description: '1-based step index' } } },
  },
  {
    name: 'capture_value',
    description: 'Read a non-secret value created by F&O (for example a new document number) from a data-dyn-controlname control. The app constructs and executes the Playwright read; never provide JavaScript. Use mode value for an input field or text for text content.',
    inputSchema: { type: 'object', required: ['name', 'control', 'mode'], properties: { name: { type: 'string', description: 'Variable identifier, e.g. salesOrderId' }, control: { type: 'string', description: 'Exact D365 data-dyn-controlname, e.g. SalesTable_SalesId' }, mode: { type: 'string', enum: ['value', 'text'] } } },
  },
  {
    name: 'report_step',
    description:
      'Record the verdict for a single test step. Call this immediately after observing the result of each step.',
    inputSchema: { type: 'object', required: ['index', 'status'], properties: STEP_VERDICT_PROPERTIES },
  },
  {
    name: 'report_steps',
    description:
      'Record the verdicts of several steps in one call, e.g. a run of steps that are blocked or skipped for the same reason. Each entry takes the same fields as report_step.',
    inputSchema: {
      type: 'object',
      required: ['steps'],
      properties: {
        steps: { type: 'array', items: { type: 'object', required: ['index', 'status'], properties: STEP_VERDICT_PROPERTIES } },
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
  /** Reads F&O data for `d365_odata_query`. Built from the configuration when not given; tests pass a fake. */
  odata?: Pick<ODataClient, 'query'>;
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
  suggestedParameters?: NonNullable<TestResult['suggestedParameters']>;
  specFile?: string;
  dataFile?: string;
  usage: CaseUsage;
  errorMessage?: string;
}

/** What the agent found in F&O for values the case leaves unset, and what F&O returned (to tell where a value came from). */
interface FillState {
  values: Map<string, { value: string; source: 'odata' | 'agent'; how?: string }>;
  seen: string[];
}

/** Bookkeeping behind the step verdicts the run corrects on the model's behalf. */
interface VerdictState {
  /**
   * Steps preflight found missing data for (blocked before the run, or with an unset expected result). Preflight
   * blocks them for a reason of their own, so they never turn a later failure into blocked.
   */
  preflight: Set<number>;
  /**
   * Steps recorded because of another step: `from` is that step. With `original`, a failure recorded as blocked
   * (restored if `from` turns out not to be blocked after all); without it, a step blocked on a shared placeholder.
   */
  derived: Map<number, { from: number; original?: StepResult }>;
  /** Failures recorded as blocked in the current model response. */
  converted: number[];
  /** finish_test was already kept open once for such failures. */
  confirmAsked: boolean;
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
  private odata?: Pick<ODataClient, 'query'>;
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
    this.odata = opts.odata;
  }

  private odataEnabled(): boolean {
    return odataEnabled(this.cfg);
  }

  private fillEnabled(): boolean {
    return fillFromErpEnabled(this.cfg);
  }

  /** Cancellation stops in-flight requests and prevents dispatching any subsequent action. */
  async runTestCase(tc: TestCase, signal?: AbortSignal): Promise<TestResult> {
    const startedAt = new Date().toISOString();
    let result: AttemptResult;
    try {
      const preflight = tc.problems?.length || this.cfg.AGENT_PREFLIGHT === 'off' ? undefined : await this.preflight(tc, signal);
      result = tc.problems?.length && !signal?.aborted
        ? this.dependencyBlocked(tc, startedAt)
        : preflight && this.cfg.AGENT_PREFLIGHT !== 'partial' && preflight.missing.length
          ? this.preflightBlocked(tc, preflight, startedAt)
          : await this.runAttempt(tc, signal, preflight);
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

  /** The placeholder check, unless it is off (AGENT_PREFLIGHT=off). A check that could not be made does not stop the case. */
  private async preflight(tc: TestCase, signal?: AbortSignal): Promise<PreflightReport | undefined> {
    if (this.cfg.AGENT_PREFLIGHT === 'off') return undefined;
    try {
      const report = await withCancellation(signal, () => preflightCase(tc, this.llm, signal, { ignoreUserRole: this.cfg.AGENT_IGNORE_USER_ROLE === true, fillFromErp: this.fillEnabled() }));
      if (report.error) console.warn(`[agent] preflight skipped: ${report.error}`);
      else if (this.cfg.AGENT_VERBOSE && report.placeholders.length) {
        this.log(`preflight: ${report.placeholders.length} placeholder(s), ${report.missing.length} missing${report.missing.length ? `: ${describeMissing(report.missing)}` : ''}`);
      }
      return report;
    } catch (e) {
      signal?.throwIfAborted();
      // An outage stops the run as it would on the first agent turn; anything else only costs the check.
      const unavailable = toUnavailable(e);
      if (unavailable) throw unavailable;
      console.warn(`[agent] preflight skipped: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** A case with unreadable or recursive shared dependencies is not a shorter test: stop before any model/browser work. */
  private dependencyBlocked(tc: TestCase, startedAt: string): AttemptResult {
    const finishedAt = new Date().toISOString();
    const error = `Test case dependencies are incomplete: ${tc.problems!.join(' ')} No browser steps were run.`;
    return {
      outcome: 'blocked', runState: 'blocked', startedAt, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      steps: tc.steps.map((s) => ({ index: s.index, status: 'blocked', cause: 'missing_data', durationMs: 0, ...((tc.sourceSteps ?? tc.steps).find((source) => source.index === s.index)?.actionPath ? { actionPath: (tc.sourceSteps ?? tc.steps).find((source) => source.index === s.index)!.actionPath } : {}), observed: 'Not run: shared test-case dependencies could not be loaded completely.', errorMessage: this.clean(error, LIMITS.error) })),
      artifacts: [], learnings: [], policyBlocks: [], timeouts: [], data: {},
      usage: { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelMs: 0 },
      errorMessage: this.clean(error, LIMITS.error),
    };
  }

  /** The result of a case preflight stopped: no browser was opened. */
  private preflightBlocked(tc: TestCase, report: PreflightReport, startedAt: string): AttemptResult {
    const finishedAt = new Date().toISOString();
    const n = report.missing.length;
    return {
      outcome: 'blocked', runState: 'blocked', startedAt, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      steps: preflightSteps(tc, report.missing), artifacts: [], learnings: [], policyBlocks: [], timeouts: [], data: {}, usage: report.usage,
      errorMessage: this.clean(
        `Missing test data: the case was not run because ${n} placeholder${n > 1 ? 's' : ''} stand${n > 1 ? '' : 's'} for existing data or setup that the test case does not name: ${describeMissing(report.missing)}.${report.missing.some((p) => p.text.startsWith('@')) ? " Set a parameter in the test case's parameter values; a value that an earlier case creates is passed on when that case passes earlier in the same run (for example --case 38,39)." : ''} Fill ${n > 1 ? 'them' : 'it'} in, or run with --preflight partial to run the other steps.`,
        LIMITS.error,
      ),
    };
  }

  private async runAttempt(tc: TestCase, signal?: AbortSignal, preflight?: PreflightReport): Promise<AttemptResult> {
    signal?.throwIfAborted();
    const startedAt = new Date();
    const artifactsDir = join(this.cfg.REPORT_DIR, 'artifacts', tc.id, tc.parameters && tc.parameters.rows > 1 ? `row-${tc.parameters.row}` : '');
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
      ...(this.odataEnabled() ? [odataTool(this.fillEnabled())] : []),
      ...(this.fillEnabled() ? [RECORD_PARAMETER_TOOL] : []),
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

    // In partial mode the steps preflight found missing data for are recorded as blocked up front, so the agent
    // runs only the others instead of working out, step by step, what it already cannot do. A step that only lacks
    // its expected result is still done (later steps may need what it creates); it just cannot be checked.
    const split = preflight?.missing.length ? splitMissing(preflight.missing) : { cannotRun: [], cannotCheck: [] };
    const preBlocked = split.cannotRun.length ? preflightSteps(tc, split.cannotRun).filter((s) => s.status === 'blocked') : [];
    const messages: LlmMessage[] = [{ role: 'user', content: testCaseUserPrompt(tc, preBlocked, split.cannotCheck, preflight?.lookup ?? [], this.fillEnabled() && (!preflight || preflight.error) ? { company: tc.legalEntity ?? this.cfg.D365_COMPANY, ignoreUserRole: this.cfg.AGENT_IGNORE_USER_ROLE === true } : undefined) }];
    const fill: FillState = { values: new Map(), seen: [] };
    const steps: StepResult[] = [...preBlocked];
    // Placeholders a step blocked on can block the other steps that use them; never ones preflight found to be
    // values the agent may generate or the configuration covers.
    const notMissing = new Set((preflight?.error ? [] : preflight?.placeholders ?? []).filter((p) => p.kind !== 'missing').map((p) => `${p.step}|${p.text}`));
    const placeholders = placeholdersByStep(findPlaceholders(tc).filter((p) => !notMissing.has(`${p.step}|${p.text}`)));
    const browser = { changed: false };
    const verdicts: VerdictState = { preflight: new Set([...preBlocked.map((s) => s.index), ...split.cannotCheck.map((p) => p.step)]), derived: new Map(), converted: [], confirmAsked: false };
    const learnings: string[] = [];
    const artifacts: string[] = [];
    const policyBlocks: string[] = [];
    const timeouts: string[] = [];
    const data: Record<string, string> = {};
    const recording = newRecording(tc);
    const page = { key: undefined as string | undefined, hinted: new Set<string>() };
    let outcome: StepStatus = 'blocked';
    let overallError: string | undefined;
    /** The outcome is the model's own finish_test verdict, not a stop the run imposed. */
    let modelVerdict = false;
    let stopped = false;
    const maxRepeats = this.cfg.AGENT_MAX_REPEATED_CALLS ?? DEFAULT_MAX_REPEATED_CALLS;
    let lastCallKey: string | undefined;
    let repeats = 0;
    const guard = new AttemptGuard(this.cfg);
    const maxTurns = turnBudget(this.cfg.AGENT_MAX_STEPS, tc.steps.length);
    let turns = 0;
    let finished = false;
    // The preflight call counts toward the case's usage and token budget, but not toward its agent turns.
    const usage: CaseUsage = preflight ? { ...preflight.usage } : { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelMs: 0 };
    if (preflight?.usage.turns) guard.recordUsage(preflight.usage);

    try {
      for (let iter = 0; iter < maxTurns && !stopped && !signal?.aborted; iter++) {
        turns = iter + 1;
        verdicts.converted = [];
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
            recording,
            guard,
            page,
            placeholders,
            browser,
            verdicts,
            fill,
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
            modelVerdict = true;
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

    // The model's failed/blocked verdict must agree with its step verdicts: "failed" means a step failed.
    if (modelVerdict && !interrupted && (outcome === 'failed' || outcome === 'blocked')) {
      const rolled = rollupOutcome(outcome, steps);
      if (rolled.outcome !== outcome) {
        outcome = rolled.outcome;
        overallError = rolled.errorMessage ? this.clean(rolled.errorMessage, LIMITS.error) : overallError;
      }
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

    // A case that stopped partway through a form must not leave its half-made record to be saved later.
    if (browser.changed && outcome !== 'passed' && !signal?.aborted && this.cfg.AGENT_DISCARD_UNSAVED !== false && !this.cfg.AGENT_DRY_RUN) {
      await this.discardUnsaved(signal);
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
    let generated: { specFile: string; dataFile: string } | undefined;
    if (!interrupted && !this.cfg.AGENT_DRY_RUN && this.cfg.AGENT_RECORD_TESTS !== false && (recording.setup.length || recording.steps.some((s) => s.code.length))) {
      try {
        const recordedRow = Math.max(0, (tc.parameters?.row ?? 1) - 1);
        const rows = Array.from({ length: iterationCount(tc) }, (_, row) => valuesForRow(tc.parameterData ?? [], row));
        for (const [key, value] of Object.entries(data)) {
          const name = key.replace(/^@/, '');
          const isParameter = (tc.parameters?.filled ?? []).some((p) => p.toLowerCase() === name.toLowerCase())
            || (tc.parameters?.unresolved ?? []).some((p) => p.toLowerCase() === name.toLowerCase())
            || rows.some((row) => name in row);
          if (isParameter) for (const row of rows) if (!row[name]) row[name] = value;
        }
        const sensitive = rows.some((row) => Object.entries(row).some(([name, value]) =>
          /(?:password|passwd|secret|credential|access.?token|api.?key)/i.test(name) || redactSecrets(this.cfg, value) !== value));
        if (sensitive) {
          console.warn('[agent] standalone recording was not saved because a parameter row contains secret-shaped data');
        } else {
          generated = writeSpec({
            cfg: replayProjectConfig(this.cfg), testCase: tc, rows: rows.length ? rows : [{}], recordedRow,
            setup: recording.setup, steps: recording.steps, vars: recording.vars,
            result: { outcome, summary: overallError ?? learnings.at(-1) ?? `Recording finished ${outcome}.` },
          });
          artifacts.push(generated.specFile, generated.dataFile);
        }
      } catch (e) {
        console.warn(`[agent] could not save the standalone Playwright recording: ${redactSecrets(this.cfg, (e as Error).message).slice(0, 300)}`);
      }
    }
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
      ...(generated ?? {}),
      // Only values from a case that passed are worth saving: only then is it known that they worked.
      ...(outcome === 'passed' && fill.values.size ? { suggestedParameters: [...fill.values].map(([name, v]) => ({ name, ...v })) } : {}),
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
      recording: RecordingState;
      guard: AttemptGuard;
      /** The F&O form the browser is on, and the forms whose learned hints were already shown this attempt. */
      page: { key?: string; hinted: Set<string> };
      /** The placeholders of each step (0 = preconditions), to block the other steps that use one found missing. */
      placeholders: Map<number, Placeholder[]>;
      /** Set once a browser action that can change data was sent to the page. */
      browser: { changed: boolean };
      verdicts: VerdictState;
      fill: FillState;
      signal?: AbortSignal;
    },
    opts: { noHint?: boolean } = {},
  ): Promise<DispatchResult> {
    ctx.signal?.throwIfAborted();
    const args: Record<string, unknown> =
      call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments : {};
    const fail = (error: string): DispatchResult => ({ content: JSON.stringify({ error }), errored: true });

    if (call.name === 'begin_step') {
      const index = typeof args.index === 'string' && /^\d+$/.test(args.index) ? Number(args.index) : args.index;
      if (typeof index !== 'number' || !beginRecordingStep(ctx.recording, ctx.tc, index)) return fail(`Invalid step index ${JSON.stringify(index)}. Use one of: ${ctx.tc.steps.map((s) => s.index).join(', ')}.`);
      return { content: JSON.stringify({ ok: true, recordingStep: index }) };
    }
    if (call.name === 'capture_value') return this.captureValue(args, ctx);
    if (call.name === 'report_step') {
      const r = this.recordStep(args, ctx, 'report_step');
      if ('error' in r) return fail(r.error);
      return { content: JSON.stringify(r.reply), ...(r.stop ? { stop: r.stop } : {}) };
    }
    if (call.name === 'report_steps') {
      const list = Array.isArray(args.steps) ? args.steps : undefined;
      if (!list?.length) return fail('Pass `steps`: a non-empty array of step verdicts, each with the fields of report_step. Nothing was recorded.');
      if (list.length > ctx.tc.steps.length) return fail(`The case has ${ctx.tc.steps.length} steps; got ${list.length} verdicts. Nothing was recorded.`);
      const replies: unknown[] = [];
      let errors = 0;
      for (const item of list) {
        const entry = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
        const r = this.recordStep(entry, ctx, 'report_steps');
        if ('error' in r) {
          errors++;
          replies.push({ index: entry.index ?? null, error: r.error });
          continue;
        }
        replies.push(r.reply);
        // A sign-in problem ends the attempt: the remaining entries are not recorded.
        if (r.stop) return { content: JSON.stringify({ results: replies }), stop: r.stop };
      }
      return { content: JSON.stringify({ results: replies }), ...(errors === list.length ? { errored: true } : {}) };
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
    if (call.name === ODATA_TOOL_NAME) return this.odataQuery(args, ctx);
    if (call.name === RECORD_PARAMETER_TOOL_NAME) return this.recordParameter(args, ctx);
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
      // A failure recorded as blocked in this same response: the model has not seen why, so it could not say that
      // the failure is a defect of its own. Keep the test open once to let it, rather than hide a real defect.
      const unseen = ctx.verdicts.converted.filter((i) => ctx.steps.find((s) => s.index === i)?.status === 'blocked');
      if (unseen.length && !ctx.verdicts.confirmAsked) {
        ctx.verdicts.confirmAsked = true;
        return {
          content: JSON.stringify({
            ok: false,
            testStillOpen: true,
            note: `Step ${unseen.join(', ')} ${unseen.length > 1 ? 'were' : 'was'} recorded as blocked, not failed, because an earlier step was blocked. If a failure is a product defect of its own, report that step again with independent: true. Then call finish_test again.`,
          }),
        };
      }
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
      // Before the call: one that errors or times out may still have filled part of a form.
      if (fno && isMutatingBrowserTool(toolName)) ctx.browser.changed = true;
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
      if (fno && RECORDABLE_BROWSER_TOOLS.has(toolName) && !res.isError && !this.cfg.AGENT_DRY_RUN && this.cfg.AGENT_RECORD_TESTS !== false) {
        appendRecording(ctx.recording, ctx.tc, ctx.steps, extractPlaywrightCode(text));
      }
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

  /** Reads only an app-constructed D365 locator expression through the hidden trusted code tool. */
  private async captureValue(args: Record<string, unknown>, ctx: Parameters<AgentOrchestrator['dispatch']>[1]): Promise<DispatchResult> {
    const fail = (error: string): DispatchResult => ({ content: JSON.stringify({ error }), errored: true });
    if ('expression' in args || 'code' in args || 'javascript' in args) return fail('capture_value does not accept JavaScript or expressions. Pass only name, control and mode.');
    const problem = validCaptureRequest(args.name, args.control, args.mode);
    if (problem) return fail(problem);
    if (this.cfg.AGENT_DRY_RUN) return { content: JSON.stringify({ dryRun: true, note: 'Skipped dynamic value capture' }) };
    if (!this.cfg.D365_BASE_URL) return fail('Dynamic capture requires the configured D365 URL.');
    if (!this.mcpServers.includes('playwright') || !this.toolCache.get('playwright')?.some((t) => t.name === 'browser_run_code')) {
      return fail('Dynamic capture is unavailable: the browser does not expose the trusted internal read operation. Record the visible value with record_value instead, if it is not secret.');
    }
    const name = args.name as string;
    const control = args.control as string;
    const mode = args.mode as 'value' | 'text';
    if (!(name in ctx.data) && Object.keys(ctx.data).length >= MAX_DATA_KEYS) return fail(`At most ${MAX_DATA_KEYS} values can be recorded per run. Nothing was captured.`);
    try {
      const res = await this.callMcp('playwright', 'browser_run_code', { code: captureToolCode(control, mode, this.cfg.D365_BASE_URL) }, this.cfg.AGENT_TOOL_TIMEOUT_MS, ctx.signal);
      if (res.isError) return { content: redactSecrets(this.cfg, JSON.stringify({ error: `The value could not be read: ${mcpErrorText(res.content)}` })), errored: true };
      const text = responseText(res.content);
      const block = /###\s*Result\s*\n([\s\S]*?)(?=\n###|\s*$)/.exec(text)?.[1].trim() ?? '';
      let raw = block;
      if (block) {
        try { raw = String(JSON.parse(block)); } catch { raw = block.replace(/^"|"$/g, ''); }
      }
      const value = this.clean(raw, LIMITS.dataValue);
      if (!value.trim()) return fail('The control returned an empty value. Nothing was captured.');
      if (value.includes('***')) return fail('The value looks secret-shaped and was not stored or added to the recording.');
      ctx.data[name] = value;
      const step = recordingStep(ctx.recording, ctx.tc, ctx.steps) ?? -1;
      const at = step < 0 ? ctx.recording.setup.length : (ctx.recording.steps.find((s) => s.index === step)?.code.length ?? 0);
      ctx.recording.vars.push({ name, value, expression: captureExpression(control, mode), step, at });
      return { content: JSON.stringify({ ok: true, captured: name, value }) };
    } catch (e) {
      ctx.signal?.throwIfAborted();
      return { content: redactSecrets(this.cfg, JSON.stringify({ error: `The value could not be read: ${(e as Error).message}` })), errored: true };
    }
  }

  /**
   * One read-only OData query against the configured F&O address. A problem with the sign-in or the query is reported
   * to the model without counting as a failing tool call, so a missing data-access sign-in never stops a run: the
   * agent carries on in the browser.
   */
  private async odataQuery(args: Record<string, unknown>, ctx: Parameters<AgentOrchestrator['dispatch']>[1]): Promise<DispatchResult> {
    if (!this.odataEnabled()) return { content: JSON.stringify({ error: 'Reading F&O data over OData is off. Use the browser.' }), errored: true };
    const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
    const company = text(args.company)?.trim();
    // Same rule as for page links: a case stays inside its legal entity.
    if (company && ctx.tc.legalEntity && company.toLowerCase() !== ctx.tc.legalEntity.toLowerCase()) {
      const note = this.clean(`${ODATA_TOOL_NAME}: company ${company} is not the test's legal entity ${ctx.tc.legalEntity}`, LIMITS.blockNote);
      ctx.policyBlocks.push(note);
      console.warn(`[guardrail] blocked ${note}`);
      return { content: JSON.stringify({ error: `Blocked by policy: company ${company} is not this test's legal entity (${ctx.tc.legalEntity}). Retrying will not help.` }), policyBlocked: true };
    }
    try {
      this.odata ??= new ODataClient(this.cfg);
      const top = args.top === undefined ? undefined : Number(args.top);
      const result = await this.odata.query({ entity: String(args.entity ?? ''), select: text(args.select), filter: text(args.filter), orderby: text(args.orderby), top, company }, ctx.signal);
      const answer = redactSecrets(this.cfg, JSON.stringify(result));
      // Remembered so a value the agent later records can be told apart: found in F&O, or chosen another way.
      ctx.fill.seen.push(answer);
      if (ctx.fill.seen.length > 40) ctx.fill.seen.shift();
      return { content: answer };
    } catch (e) {
      ctx.signal?.throwIfAborted();
      const usable = e instanceof ODataSignInError;
      return {
        content: redactSecrets(this.cfg, JSON.stringify({ error: `${(e as Error).message}${usable ? ' If data access is not available, check the page in the browser instead.' : ''}` })),
        ...(usable ? {} : { errored: true }),
      };
    }
  }

  /**
   * Saves the value the agent chose for a parameter the case leaves unset. Only a parameter that is still unfilled
   * in the steps can be recorded: that is what could later be suggested for the test case's parameter values.
   */
  private recordParameter(args: Record<string, unknown>, ctx: Parameters<AgentOrchestrator['dispatch']>[1]): DispatchResult {
    const fail = (error: string): DispatchResult => ({ content: JSON.stringify({ error }), errored: true });
    if (!this.fillEnabled()) return fail('Filling unset values from F&O is off. Nothing was recorded.');
    const name = typeof args.name === 'string' ? args.name.trim().replace(/^@/, '') : '';
    const value = typeof args.value === 'string' ? args.value.trim() : '';
    if (!name || !value) return fail('Both `name` and `value` are required, as non-empty strings. Nothing was recorded.');
    const open = ctx.tc.parameters?.unresolved ?? [];
    const match = open.find((n) => n.toLowerCase() === name.toLowerCase());
    if (!match) {
      // Not a failing call: the value can still be used in the step, it just has no parameter to be saved to.
      return { content: JSON.stringify({ error: `'${this.clean(name, 60)}' is not an unfilled parameter of this case${open.length ? ` (those are: ${open.map((n) => `@${n}`).join(', ')})` : ''}. Use the value in the step and mention it in \`observed\`. Nothing was recorded.` }) };
    }
    const clean = this.clean(value, LIMITS.dataValue);
    const how = typeof args.how === 'string' && args.how.trim() ? this.clean(args.how.trim(), 200) : undefined;
    const source = ctx.fill.seen.some((t) => t.toLowerCase().includes(clean.toLowerCase())) ? 'odata' : 'agent';
    ctx.fill.values.set(match, { value: clean, source, ...(how ? { how } : {}) });
    if (`@${match}` in ctx.data || Object.keys(ctx.data).length < MAX_DATA_KEYS) ctx.data[`@${match}`] = clean;
    return { content: JSON.stringify({ ok: true, recorded: `@${match}`, source }) };
  }

  /**
   * Validates and records one step verdict (report_step, or one entry of report_steps).
   *
   * Two corrections keep the verdicts honest without costing model turns:
   * - A failure after an earlier step was blocked for missing data or a missing page is recorded as blocked: it is
   *   almost always the consequence (the record that could not be saved is then not found), not a product defect.
   *   The model can still record a defect of its own with `independent: true`.
   * - A step blocked for missing data blocks every not-yet-reported step that uses the same placeholder.
   */
  private recordStep(
    args: Record<string, unknown>,
    ctx: Parameters<AgentOrchestrator['dispatch']>[1],
    tool: 'report_step' | 'report_steps',
  ): { error: string } | { reply: Record<string, unknown>; stop?: RunStop } {
    const validIndexes = ctx.tc.steps.map((s) => s.index);
    const index = typeof args.index === 'string' && /^\d+$/.test(args.index) ? Number(args.index) : args.index;
    if (typeof index !== 'number' || !validIndexes.includes(index)) {
      return { error: `Invalid step index ${JSON.stringify(index)}. Use one of: ${validIndexes.join(', ')}. Nothing was recorded.` };
    }
    if (!STEP_STATUSES.includes(args.status as StepStatus)) {
      return { error: `Invalid status ${JSON.stringify(args.status)} for step ${index}. Use one of: ${STEP_STATUSES.join(', ')}. Nothing was recorded.` };
    }
    const expected = ctx.tc.steps.find((s) => s.index === index)?.expected;
    if (expected && args.status === 'passed' && typeof args.verified !== 'boolean') {
      return { error: `Step ${index} has an expected result (${this.clean(expected, 200)}). Check it against a fresh browser_snapshot, then call ${tool} again with verified=true (quote what you saw in \`observed\`), or verified=false if you could not check it. Nothing was recorded.` };
    }
    const step: StepResult = {
      index,
      status: args.status as StepStatus,
      ...((ctx.tc.sourceSteps ?? ctx.tc.steps).find((s) => s.index === index)?.actionPath ? { actionPath: (ctx.tc.sourceSteps ?? ctx.tc.steps).find((s) => s.index === index)!.actionPath } : {}),
      ...(typeof args.verified === 'boolean' ? { verified: args.verified } : {}),
      ...((args.status === 'failed' || args.status === 'blocked') && STEP_CAUSES.includes(args.cause as StepCause) ? { cause: args.cause as StepCause } : {}),
      observed: typeof args.observed === 'string' ? this.clean(args.observed, LIMITS.observed) : undefined,
      errorMessage: typeof args.errorMessage === 'string' ? this.clean(args.errorMessage, LIMITS.error) : undefined,
      durationMs: 0,
    };
    const reply: Record<string, unknown> = { ok: true, recorded: index };
    const v = ctx.verdicts;
    // The model now speaks for this step itself: it is no longer derived from another one.
    v.derived.delete(index);

    // A sign-in failure is never a consequence of missing data: it must stop the run as it always did.
    const original = { ...step };
    if (step.status === 'failed' && args.independent !== true && step.cause !== 'sign_in') {
      const blocker = this.blockerFor(index, ctx);
      if (blocker) {
        this.convertToBlocked(step, original, blocker);
        v.derived.set(index, { from: blocker.index, original });
        v.converted.push(index);
        reply.recordedAs = 'blocked';
        reply.note = `Recorded as blocked, not failed: step ${blocker.index} before it was blocked (${blocker.cause}), and a failure after that is usually its consequence (a record that was never saved cannot be found). If this step failed for a reason of its own, a product defect, report it again with independent: true.`;
      }
    }

    const existing = ctx.steps.findIndex((s) => s.index === index);
    if (existing >= 0) ctx.steps[existing] = step;
    else ctx.steps.push(step);
    finishRecordingStep(ctx.recording, index, step.status, step.observed ?? step.errorMessage);

    // Only a block the model reported itself says which placeholder is missing.
    if (step.status === 'blocked' && step.cause === 'missing_data' && reply.recordedAs === undefined) {
      const also = this.blockSharedPlaceholders(step, ctx);
      if (also.length) {
        reply.alsoBlocked = also;
        reply.alsoBlockedNote = `Step ${also.join(', ')} ${also.length > 1 ? 'use' : 'uses'} the same placeholder and ${also.length > 1 ? 'were' : 'was'} recorded as blocked too: do not run ${also.length > 1 ? 'them' : 'it'}.`;
      }
    }

    // A step that is no longer blocked releases the steps recorded because of it.
    if (!(step.status === 'blocked' && step.cause && DEPENDENCY_CAUSES.has(step.cause))) {
      const { released, restored } = this.releaseDependents(index, ctx);
      if (released.length) {
        reply.released = released;
        reply.releasedNote = `Step ${released.join(', ')} ${released.length > 1 ? 'were' : 'was'} only blocked because of step ${index} and ${released.length > 1 ? 'are' : 'is'} open again: run ${released.length > 1 ? 'them' : 'it'}.`;
      }
      if (restored.length) reply.restoredAsFailed = restored;
    }

    if ((step.status === 'failed' || step.status === 'blocked') && step.cause === 'sign_in') {
      const stop = ctx.guard.authStop({ kind: 'mfa', evidence: step.observed ?? 'reported by the model' });
      if (stop) return { reply, stop };
    }
    return { reply };
  }

  /** The closest earlier step blocked for missing data, a missing page or missing access. Preflight's blocks do not count. */
  private blockerFor(index: number, ctx: Parameters<AgentOrchestrator['dispatch']>[1], except?: number): StepResult | undefined {
    return ctx.steps
      .filter((s) => s.index < index && s.index !== except && !ctx.verdicts.preflight.has(s.index) && s.status === 'blocked' && s.cause && DEPENDENCY_CAUSES.has(s.cause))
      .sort((a, b) => b.index - a.index)[0];
  }

  private convertToBlocked(step: StepResult, original: StepResult, blocker: StepResult): void {
    step.status = 'blocked';
    step.cause = blocker.cause;
    const reported = original.errorMessage ?? original.observed ?? 'no details were given';
    step.errorMessage = this.clean(`Depends on step ${blocker.index}, which was blocked (${blocker.cause}). Reported failure${original.cause ? ` (${original.cause})` : ''}: ${reported}`, LIMITS.error);
  }

  /**
   * After step `from` was recorded as not blocked: steps blocked on its placeholder count as not reported again, and
   * failures recorded as blocked because of it are failures again, unless another earlier step still blocks them.
   */
  private releaseDependents(from: number, ctx: Parameters<AgentOrchestrator['dispatch']>[1]): { released: number[]; restored: number[] } {
    const released: number[] = [];
    const restored: number[] = [];
    // Released steps are sources too: a failure converted because of a step that was itself only blocked on step
    // `from`'s placeholder is released with it.
    const sources = [from];
    for (let i = 0; i < sources.length; i++) {
      for (const [index, d] of [...ctx.verdicts.derived]) {
        if (d.from !== sources[i] || d.original) continue;
        const at = ctx.steps.findIndex((s) => s.index === index);
        ctx.verdicts.derived.delete(index);
        if (at >= 0) ctx.steps.splice(at, 1);
        released.push(index);
        sources.push(index);
      }
    }
    for (const [index, d] of [...ctx.verdicts.derived]) {
      if (!d.original || !sources.includes(d.from)) continue;
      const at = ctx.steps.findIndex((s) => s.index === index);
      const other = this.blockerFor(index, ctx, from);
      if (other && at >= 0) {
        const step = { ...d.original };
        this.convertToBlocked(step, d.original, other);
        ctx.steps[at] = step;
        ctx.verdicts.derived.set(index, { from: other.index, original: d.original });
      } else {
        ctx.verdicts.derived.delete(index);
        if (at >= 0) ctx.steps[at] = { ...d.original };
        restored.push(index);
      }
    }
    return { released: released.sort((a, b) => a - b), restored: restored.sort((a, b) => a - b) };
  }

  /**
   * Blocks the unreported steps that use the placeholder `step` was blocked on, and returns their indexes. Only a
   * placeholder the agent named in its reason counts (rule 3 asks it to), so another one in the same step is not
   * taken for the missing value.
   */
  private blockSharedPlaceholders(step: StepResult, ctx: Parameters<AgentOrchestrator['dispatch']>[1]): number[] {
    const said = placeholderKey(`${step.errorMessage ?? ''} ${step.observed ?? ''}`);
    const own = (ctx.placeholders.get(step.index) ?? []).filter((p) => isDescriptive(p.text) && said.includes(placeholderKey(p.text)));
    if (!own.length) return [];
    const keys = new Set(own.map((p) => placeholderKey(p.text)));
    const reported = new Set(ctx.steps.map((s) => s.index));
    const blocked: number[] = [];
    for (const [index, list] of ctx.placeholders) {
      if (index === 0 || reported.has(index)) continue;
      const shared = list.find((p) => keys.has(placeholderKey(p.text)));
      if (!shared) continue;
      ctx.steps.push({
        index, status: 'blocked', cause: 'missing_data', durationMs: 0, observed: 'Not run.',
        errorMessage: this.clean(`Uses the placeholder "${shared.text}", which step ${step.index} was blocked on: the test case leaves it unset.`, LIMITS.error),
      });
      ctx.verdicts.derived.set(index, { from: step.index });
      blocked.push(index);
    }
    return blocked.sort((a, b) => a - b);
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
            : `'${this.clean(page, 80)}' is not in the list of pages this tool knows. That does not mean F&O lacks it. Pass its menu item name as menuItem if you know it; otherwise open it in the browser with the navigation search box ("Search for a page"), and report the step blocked with cause "not_found" only if F&O's own search cannot find it either.`,
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

  /** Discards the unsaved changes of the form the browser is on. Never saves; failures are only logged. */
  private async discardUnsaved(signal?: AbortSignal): Promise<void> {
    // Short budgets: the case is already over, possibly because the page hung.
    const timeout = Math.min(this.cfg.AGENT_TOOL_TIMEOUT_MS ?? 60000, DISCARD_TIMEOUT_MS);
    try {
      for (const key of DISCARD_KEYS) {
        const res = await this.callMcp('playwright', 'browser_press_key', { key }, timeout, signal);
        if (res.isError) {
          console.warn(`[agent] the unsaved changes of the open form may not have been discarded: ${key} failed (${this.clean(mcpErrorText(res.content), 200)})`);
          return;
        }
        await this.waitForFno(signal, timeout);
      }
      if (this.cfg.AGENT_VERBOSE) this.log('discarded the unsaved changes of the open form');
    } catch (e) {
      signal?.throwIfAborted();
      console.warn(`[agent] the unsaved changes of the open form may not have been discarded: ${(e as Error).message}`);
    }
  }

  /** Waits for F&O's blocking overlay to clear. Returns at once when it is not shown. */
  private async waitForFno(signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    try {
      await this.callMcp('playwright', 'browser_wait_for', { textGone: FNO_BUSY_TEXT }, timeoutMs ?? this.cfg.AGENT_NAV_TIMEOUT_MS ?? 60000, signal);
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

/**
 * The model's failed or blocked verdict made to agree with its step verdicts. "failed" claims a product defect: when
 * no step failed and a step was blocked, the case is blocked. (With no step verdicts at all there is nothing to judge
 * by, so the model's word stands.) And a case with a failed step is failed, even when the model called it blocked
 * because a later step could not run, so the defect is not hidden among data problems.
 */
export function rollupOutcome(outcome: StepStatus, steps: StepResult[]): { outcome: StepStatus; errorMessage?: string } {
  const failed = steps.filter((s) => s.status === 'failed').sort((a, b) => a.index - b.index);
  const blocked = steps.filter((s) => s.status === 'blocked').sort((a, b) => a.index - b.index);
  const detail = (s: StepResult): string => s.errorMessage ?? s.observed ?? 'no details were reported';
  if (outcome === 'failed' && !failed.length && blocked.length) {
    return {
      outcome: 'blocked',
      errorMessage: `Not counted as failed: no step failed. Step ${blocked[0].index} blocked${blocked[0].cause ? ` (${blocked[0].cause})` : ''}: ${detail(blocked[0])}`,
    };
  }
  if (outcome === 'blocked' && failed.length) {
    return { outcome: 'failed', errorMessage: `Step ${failed.map((s) => s.index).join(', ')} failed: ${detail(failed[0])}` };
  }
  return { outcome };
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
