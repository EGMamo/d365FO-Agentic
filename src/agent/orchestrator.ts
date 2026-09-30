import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../config/index.js';
import type { LlmProvider } from '../llm/index.js';
import type { LlmMessage, LlmTool, LlmToolCall } from '../llm/types.js';
import type { McpManager, McpToolDescriptor } from '../mcp/manager.js';
import type { KnowledgeBase } from '../knowledge/kb.js';
import type { RunState, StepResult, StepStatus, TestCase, TestResult } from '../testing/types.js';
import { CREDENTIAL_TOOL, CREDENTIAL_TOOL_NAME, browserTypeArgs, credentialFor, mcpErrorText, redactSecrets } from '../d365fo/login.js';
import { baseSystemPrompt, testCaseUserPrompt } from './prompts.js';
import { compactHistory } from './context.js';
import { Guardrails } from './guardrails.js';
import { toUnavailable } from '../llm/errors.js';

const DEFAULT_MAX_REPEATED_CALLS = 3;
const DEFAULT_CONTEXT_KEEP_RECENT = 3;
/** An attempt that keeps hitting the guardrails is stopped instead of probing for a way around them. */
const MAX_POLICY_BLOCKS = 5;
const MAX_LEARNINGS = 10;
const STEP_STATUSES: readonly StepStatus[] = ['passed', 'failed', 'skipped', 'blocked'];
const LEARNING_KINDS = ['selector', 'recipe', 'remediation', 'doc'] as const;
const MAX_DATA_KEYS = 20;
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

interface RunOptions {
  cfg: AppConfig;
  llm: LlmProvider;
  mcp: McpManager;
  kb: KnowledgeBase;
  mcpServers: string[];
}

interface AttemptResult {
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
}

interface DispatchResult {
  content: string;
  done?: boolean;
  outcome?: StepStatus;
  errorMessage?: string;
  policyBlocked?: boolean;
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

  constructor(opts: RunOptions) {
    this.cfg = opts.cfg;
    this.llm = opts.llm;
    this.mcp = opts.mcp;
    this.kb = opts.kb;
    this.mcpServers = opts.mcpServers;
    this.guardrails = new Guardrails(opts.cfg, opts.mcpServers);
  }

  async runTestCase(tc: TestCase): Promise<TestResult> {
    let state: RunState = 'pending';
    const attempts: AttemptResult[] = [];
    const maxAttempts = Math.max(1, this.cfg.AGENT_RELOOP_MAX_RETRIES + 1);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      state = attempt === 1 ? 'running' : 'retrying';
      const result = await this.runAttempt(tc);
      attempts.push(result);

      if (!shouldRetry(result.outcome, this.cfg.AGENT_RELOOP_RETRY_ON, attempt, maxAttempts)) {
        state = result.outcome === 'passed' || result.outcome === 'skipped' ? 'completed' : result.runState;
        break;
      }
      if (this.cfg.AGENT_RELOOP_COOLDOWN_MS > 0) {
        await sleep(this.cfg.AGENT_RELOOP_COOLDOWN_MS);
      }
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

    const previous = attempts.length > 1 ? attempts[attempts.length - 2] : undefined;
    const policyBlocks = Array.from(new Set(attempts.flatMap((a) => a.policyBlocks))).slice(0, 20);
    const timeouts = Array.from(new Set(attempts.flatMap((a) => a.timeouts))).slice(0, 20);
    const finalState: RunState =
      final.outcome === 'passed' || final.outcome === 'skipped' ? 'completed' : final.outcome === 'failed' ? 'failed' : 'blocked';

    return {
      testCaseId: tc.id,
      title: tc.title,
      outcome: final.outcome,
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

  private async runAttempt(tc: TestCase): Promise<AttemptResult> {
    const startedAt = new Date();
    const artifactsDir = join(this.cfg.REPORT_DIR, 'artifacts', tc.id);
    await mkdir(artifactsDir, { recursive: true });

    const mcpTools: McpToolDescriptor[] = [];
    for (const server of this.mcpServers) {
      try {
        const tools = await this.mcp.listTools(server);
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
    const tools: LlmTool[] = [
      ...allowedTools.map((t) => ({
        name: `${t.server}__${t.name}`,
        description: `[${t.server}] ${t.description}`,
        inputSchema: t.inputSchema,
      })),
      ...LOCAL_TOOLS,
      CREDENTIAL_TOOL,
    ];

    const retrieved = this.kb.retrieve(
      `${tc.title} ${tc.module ?? ''} ${tc.tags?.join(' ') ?? ''}`,
      tc.tags ?? [],
      5,
    );

    const messages: LlmMessage[] = [{ role: 'user', content: testCaseUserPrompt(tc, retrieved) }];
    const steps: StepResult[] = [];
    const learnings: string[] = [];
    const artifacts: string[] = [];
    const policyBlocks: string[] = [];
    const timeouts: string[] = [];
    const data: Record<string, string> = {};
    let outcome: StepStatus = 'blocked';
    let overallError: string | undefined;
    let stopped = false;
    const maxRepeats = this.cfg.AGENT_MAX_REPEATED_CALLS ?? DEFAULT_MAX_REPEATED_CALLS;
    let lastCallKey: string | undefined;
    let repeats = 0;

    try {
      for (let iter = 0; iter < this.cfg.AGENT_MAX_STEPS && !stopped; iter++) {
        const compacted = compactHistory(messages, this.cfg.AGENT_CONTEXT_KEEP_RECENT ?? DEFAULT_CONTEXT_KEEP_RECENT);
        if (this.cfg.AGENT_VERBOSE && compacted > 0) this.log(`context: collapsed ${compacted} older tool result(s)`);
        const response = await this.llm.complete({
          system: baseSystemPrompt(this.cfg),
          messages,
          tools,
        });
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
          });
          if (this.cfg.AGENT_VERBOSE) this.log(`← ${dispatched.content}`);
          messages.push({
            role: 'tool',
            content: dispatched.content,
            toolCallId: call.id,
            toolName: call.name,
          });
          if (dispatched.done) {
            outcome = dispatched.outcome ?? 'blocked';
            overallError = dispatched.errorMessage;
            stopped = true;
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
    },
  ): Promise<DispatchResult> {
    const args: Record<string, unknown> =
      call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments : {};
    const fail = (error: string): DispatchResult => ({ content: JSON.stringify({ error }) });

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
        observed: typeof args.observed === 'string' ? this.clean(args.observed, LIMITS.observed) : undefined,
        errorMessage: typeof args.errorMessage === 'string' ? this.clean(args.errorMessage, LIMITS.error) : undefined,
        durationMs: 0,
      };
      const existing = ctx.steps.findIndex((s) => s.index === index);
      if (existing >= 0) ctx.steps[existing] = step;
      else ctx.steps.push(step);
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
      const rawLearnings = Array.isArray(args.learnings) ? args.learnings.slice(0, MAX_LEARNINGS) : [];
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
      await this.kb.save();
      return {
        content: JSON.stringify({ ok: true }),
        done: true,
        outcome,
        errorMessage,
      };
    }

    const idx = call.name.indexOf('__');
    if (idx < 0) return { content: JSON.stringify({ error: `Unknown tool: ${call.name}` }) };
    const server = call.name.slice(0, idx);
    const toolName = call.name.slice(idx + 2);
    const denied = this.guardrails.checkCall(server, toolName, args, ctx.tc.legalEntity);
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
      const res = await this.mcp.callTool(server, toolName, args, this.toolTimeoutMs(toolName, args));
      const captured = await this.captureBinaryContent(res.content, ctx.artifactsDir);
      ctx.artifacts.push(...captured);
      return {
        content: redactSecrets(
          this.cfg,
          typeof res.content === 'string' ? res.content : JSON.stringify(res.content ?? { ok: !res.isError }),
        ),
      };
    } catch (e) {
      if (isTimeoutError(e)) {
        const ms = this.toolTimeoutMs(toolName, args);
        const note = this.clean(`${call.name} exceeded ${Math.round(ms / 1000)}s`, LIMITS.blockNote);
        ctx.timeouts.push(note);
        return {
          content: JSON.stringify({
            error: `${call.name} timed out after ${Math.round(ms / 1000)}s. The page may still be loading or a dialog may be open: take a fresh browser_snapshot before retrying.`,
          }),
        };
      }
      return { content: redactSecrets(this.cfg, JSON.stringify({ error: (e as Error).message })) };
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
      return r.status === 'passed' && r.verified !== true;
    })
    .map((t) => t.index);
}
