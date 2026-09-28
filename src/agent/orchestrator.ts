import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../config/index.js';
import type { LlmProvider } from '../llm/index.js';
import type { LlmMessage, LlmTool, LlmToolCall } from '../llm/types.js';
import type { McpManager, McpToolDescriptor } from '../mcp/manager.js';
import type { KnowledgeBase } from '../knowledge/kb.js';
import type { StepResult, StepStatus, TestCase, TestResult } from '../testing/types.js';
import { baseSystemPrompt, testCaseUserPrompt } from './prompts.js';

/**
 * Local tools the agent can invoke directly (not routed through MCP). These
 * capture structured verdicts and knowledge-base updates in-process.
 */
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
  /** MCP servers whose tools should be exposed to the model. */
  mcpServers: string[];
}

export class AgentOrchestrator {
  private cfg: AppConfig;
  private llm: LlmProvider;
  private mcp: McpManager;
  private kb: KnowledgeBase;
  private mcpServers: string[];

  constructor(opts: RunOptions) {
    this.cfg = opts.cfg;
    this.llm = opts.llm;
    this.mcp = opts.mcp;
    this.kb = opts.kb;
    this.mcpServers = opts.mcpServers;
  }

  /**
   * Runs a single test case: builds the tool list from MCP + local tools,
   * loops plan→tool-call→result until the model calls `finish_test` or hits
   * the step budget.
   */
  async runTestCase(tc: TestCase): Promise<TestResult> {
    const startedAt = new Date();
    const artifactsDir = join(this.cfg.REPORT_DIR, 'artifacts', tc.id);
    await mkdir(artifactsDir, { recursive: true });

    // Build the tool catalogue from configured MCP servers + local tools.
    const mcpTools: McpToolDescriptor[] = [];
    for (const server of this.mcpServers) {
      try {
        const tools = await this.mcp.listTools(server);
        mcpTools.push(...tools);
      } catch (e) {
        console.warn(`[agent] failed to list tools for MCP server '${server}': ${(e as Error).message}`);
      }
    }
    const tools: LlmTool[] = [
      ...mcpTools.map((t) => ({
        // Prefix with server name so we can route back at dispatch time.
        name: `${t.server}__${t.name}`,
        description: `[${t.server}] ${t.description}`,
        inputSchema: t.inputSchema,
      })),
      ...LOCAL_TOOLS,
    ];

    // Seed with retrieved KB context.
    const retrieved = this.kb.retrieve(
      `${tc.title} ${tc.module ?? ''} ${tc.tags?.join(' ') ?? ''}`,
      tc.tags ?? [],
      5,
    );

    const messages: LlmMessage[] = [
      { role: 'user', content: testCaseUserPrompt(tc, retrieved) },
    ];

    const steps: StepResult[] = [];
    const learnings: string[] = [];
    const artifacts: string[] = [];
    let outcome: StepStatus = 'blocked';
    let overallError: string | undefined;
    let stopped = false;

    for (let iter = 0; iter < this.cfg.AGENT_MAX_STEPS && !stopped; iter++) {
      const response = await this.llm.complete({
        system: baseSystemPrompt(this.cfg),
        messages,
        tools,
      });

      // Persist assistant turn (text + tool calls).
      messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });

      if (response.toolCalls.length === 0) {
        // Model went silent without finishing — treat as blocked.
        overallError = response.text || 'Model produced no tool calls and no final verdict.';
        outcome = 'blocked';
        break;
      }

      for (const call of response.toolCalls) {
        const dispatched = await this.dispatch(call, {
          tc,
          steps,
          learnings,
          artifactsDir,
          artifacts,
        });
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

      if (response.stopReason === 'end_turn' && !stopped) {
        // No tool call, no finish → nothing more to do.
        break;
      }
    }

    const finishedAt = new Date();
    return {
      testCaseId: tc.id,
      title: tc.title,
      outcome,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      steps,
      artifacts,
      errorMessage: overallError,
      learnings,
    };
  }

  /**
   * Route a tool call from the model to either a local handler or the
   * appropriate MCP server. Returns the string content the model will see
   * plus a signal of whether this call ended the test.
   */
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
    // Local tools first.
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

    // MCP route: names are `<server>__<tool>`.
    const idx = call.name.indexOf('__');
    if (idx < 0) {
      return { content: JSON.stringify({ error: `Unknown tool: ${call.name}` }) };
    }
    const server = call.name.slice(0, idx);
    const toolName = call.name.slice(idx + 2);
    try {
      if (this.cfg.AGENT_DRY_RUN && server === 'playwright' && isMutatingBrowserTool(toolName)) {
        return {
          content: JSON.stringify({ dryRun: true, note: `Skipped mutating browser tool ${toolName}` }),
        };
      }
      const res = await this.mcp.callTool(server, toolName, call.arguments);
      // Persist Playwright screenshots to disk when returned as base64 image content.
      const captured = await this.captureBinaryContent(res.content, ctx.artifactsDir);
      ctx.artifacts.push(...captured);
      return {
        content:
          typeof res.content === 'string'
            ? res.content
            : JSON.stringify(res.content ?? { ok: !res.isError }),
      };
    } catch (e) {
      return { content: JSON.stringify({ error: (e as Error).message }) };
    }
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

function isMutatingBrowserTool(name: string): boolean {
  return /(click|type|fill|drag|press|upload|handle_dialog|select_option|navigate)/i.test(name);
}
