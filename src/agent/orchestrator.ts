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

const DEFAULT_MAX_REPEATED_CALLS = 3;

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
      },
    },
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
  errorMessage?: string;
}

export class AgentOrchestrator {
  private cfg: AppConfig;
  private llm: LlmProvider;
  private mcp: McpManager;
  private browserTypeSchema?: Record<string, unknown>;
  private kb: KnowledgeBase;
  private mcpServers: string[];

  constructor(opts: RunOptions) {
    this.cfg = opts.cfg;
    this.llm = opts.llm;
    this.mcp = opts.mcp;
    this.kb = opts.kb;
    this.mcpServers = opts.mcpServers;
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
      errorMessage: 'No attempts were executed',
    };

    const previous = attempts.length > 1 ? attempts[attempts.length - 2] : undefined;
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
    const tools: LlmTool[] = [
      ...mcpTools.map((t) => ({
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
    let outcome: StepStatus = 'blocked';
    let overallError: string | undefined;
    let stopped = false;
    const maxRepeats = this.cfg.AGENT_MAX_REPEATED_CALLS ?? DEFAULT_MAX_REPEATED_CALLS;
    let lastCallKey: string | undefined;
    let repeats = 0;

    try {
      for (let iter = 0; iter < this.cfg.AGENT_MAX_STEPS && !stopped; iter++) {
        const response = await this.llm.complete({
          system: baseSystemPrompt(this.cfg),
          messages,
          tools,
        });

        messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });
        if (this.cfg.AGENT_VERBOSE && response.text) this.log(`model: ${response.text}`);

        if (response.toolCalls.length === 0) {
          overallError = response.text || 'Model produced no tool calls and no final verdict.';
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
          }
        }

        if (response.stopReason === 'end_turn' && !stopped) break;
      }
    } catch (e) {
      outcome = 'blocked';
      overallError = `Transient orchestration failure: ${(e as Error).message}`;
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
    },
  ): Promise<{ content: string; done?: boolean; outcome?: StepStatus; errorMessage?: string }> {
    if (call.name === 'report_step') {
      const stepStart = Date.now();
      const step: StepResult = {
        index: Number(call.arguments.index ?? ctx.steps.length + 1),
        status: (call.arguments.status as StepStatus) ?? 'blocked',
        observed: call.arguments.observed as string | undefined,
        errorMessage: call.arguments.errorMessage as string | undefined,
        durationMs: Date.now() - stepStart,
      };
      ctx.steps.push(step);
      return { content: JSON.stringify({ ok: true, recorded: step.index }) };
    }
    if (call.name === CREDENTIAL_TOOL_NAME) {
      const field = String(call.arguments.field);
      const secret = credentialFor(this.cfg, call.arguments.field);
      if (!secret) {
        return {
          content: JSON.stringify({
            error: `No value configured for ${field}: set D365_USERNAME / D365_PASSWORD in .env. Mark the step BLOCKED.`,
          }),
        };
      }
      if (this.cfg.AGENT_DRY_RUN) return { content: JSON.stringify({ dryRun: true, note: 'Skipped credential entry' }) };
      const ref = (call.arguments.ref ?? call.arguments.target) as string | undefined;
      if (!ref) {
        return { content: JSON.stringify({ error: 'Missing `ref`: take the element ref from the latest browser_snapshot and call again.' }) };
      }
      try {
        const res = await this.mcp.callTool(
          'playwright',
          'browser_type',
          browserTypeArgs(this.browserTypeSchema, {
            ref,
            element: (call.arguments.element as string | undefined) ?? `${field} field`,
            text: secret,
            submit: Boolean(call.arguments.submit),
          }),
        );
        const body = res.isError
          ? { error: `The credential was configured, but typing it failed: ${mcpErrorText(res.content)}` }
          : { ok: true, entered: call.arguments.field };
        return { content: redactSecrets(this.cfg, JSON.stringify(body)) };
      } catch (e) {
        return { content: redactSecrets(this.cfg, JSON.stringify({ error: `Typing the credential failed: ${(e as Error).message}` })) };
      }
    }
    if (call.name === 'kb_search') {
      const q = (call.arguments.query as string) ?? '';
      const k = Number(call.arguments.k ?? 5);
      const hits = this.kb.retrieve(q, ctx.tc.tags ?? [], k);
      return { content: JSON.stringify(hits) };
    }
    if (call.name === 'finish_test') {
      const outcome = (call.arguments.outcome as StepStatus) ?? 'blocked';
      const errorMessage = call.arguments.errorMessage as string | undefined;
      const summary = (call.arguments.summary as string) ?? '';
      if (summary) ctx.learnings.push(summary);
      const rawLearnings = (call.arguments.learnings as
        | Array<{ kind: 'selector' | 'recipe' | 'remediation' | 'doc'; summary: string; details: string }>
        | undefined) ?? [];
      for (const l of rawLearnings) {
        this.kb.upsert({
          kind: l.kind,
          summary: l.summary,
          details: l.details,
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
    try {
      if (this.cfg.AGENT_DRY_RUN && server === 'playwright' && isMutatingBrowserTool(toolName)) {
        return { content: JSON.stringify({ dryRun: true, note: `Skipped mutating browser tool ${toolName}` }) };
      }
      const res = await this.mcp.callTool(server, toolName, call.arguments);
      const captured = await this.captureBinaryContent(res.content, ctx.artifactsDir);
      ctx.artifacts.push(...captured);
      return {
        content: redactSecrets(
          this.cfg,
          typeof res.content === 'string' ? res.content : JSON.stringify(res.content ?? { ok: !res.isError }),
        ),
      };
    } catch (e) {
      return { content: redactSecrets(this.cfg, JSON.stringify({ error: (e as Error).message })) };
    }
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
export function isMutatingBrowserTool(name: string): boolean {
  return /(click|type|fill|drag|press|upload|handle_dialog|select_option)/i.test(name);
}
