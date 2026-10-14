import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AppConfig } from '../config/index.js';
import { AgentOrchestrator } from '../agent/orchestrator.js';
import type { LlmCompleteResponse } from '../llm/types.js';
import { buildDefaultManager } from './registry.js';
import { finishTrace, snapshotFiles, traceLaunchArgs, traceOutputDir } from './playwright-trace.js';

const exists = (p: string) => stat(p).then(() => true, () => false);

async function outDir() {
  const dir = await mkdtemp(join(tmpdir(), 'trace-'));
  const out = traceOutputDir({ REPORT_DIR: dir });
  await mkdir(join(out, 'traces', 'screencast'), { recursive: true });
  return { dir, out };
}

describe('trace launch args', () => {
  it('enables the devtools tools and an output dir only when tracing is on', () => {
    assert.deepEqual(traceLaunchArgs({ PW_TRACE: 'off', REPORT_DIR: 'r' }), []);
    assert.deepEqual(traceLaunchArgs({ PW_TRACE: 'on-failure', REPORT_DIR: 'r' }), ['--caps', 'devtools', '--output-dir', traceOutputDir({ REPORT_DIR: 'r' })]);
    assert.deepEqual(traceLaunchArgs({ PW_TRACE: 'on', REPORT_DIR: 'r' }).slice(0, 2), ['--caps', 'devtools']);
  });
  it('is wired into the Playwright server arguments, and never uses a --save-trace flag (it does not exist)', () => {
    const cfg = { PW_TRACE: 'on-failure', REPORT_DIR: 'r', PW_HEADLESS: true, PW_BROWSER: 'chromium', LEARN_MCP_URL: 'u' } as AppConfig;
    const args = (buildDefaultManager(cfg) as unknown as { specs: Map<string, { args: string[] }> }).specs.get('playwright')!.args;
    assert.ok(args[args.indexOf('--caps') + 1].split(',').includes('devtools') && args.includes('--output-dir'));
    assert.equal(args.filter((a) => a === '--caps').length, 1, 'Playwright MCP reads one --caps list');
    assert.ok(!args.includes('--save-trace'));
  });
});

describe('finishTrace', () => {
  it('deletes the files a passed attempt produced when PW_TRACE=on-failure, leaving older files alone', async () => {
    const { dir, out } = await outDir();
    const old = join(out, 'traces', 'trace-1.trace');
    await writeFile(old, 'x');
    const before = await snapshotFiles(out);
    const fresh = join(out, 'traces', 'trace-2.trace');
    await writeFile(fresh, 'x');
    await writeFile(join(out, 'traces', 'screencast', 'f.jpeg'), 'x');
    assert.deepEqual(await finishTrace({ PW_TRACE: 'on-failure', REPORT_DIR: dir }, before, 'passed'), []);
    assert.equal(await exists(fresh), false);
    assert.equal(await exists(join(out, 'traces', 'screencast', 'f.jpeg')), false);
    assert.equal(await exists(old), true);
  });
  it('returns only the new .trace and .network files for a failed attempt', async () => {
    const { dir, out } = await outDir();
    const before = await snapshotFiles(out);
    for (const f of ['trace-9.trace', 'trace-9.network']) await writeFile(join(out, 'traces', f), 'x');
    await writeFile(join(out, 'traces', 'screencast', 'f.jpeg'), 'x');
    const got = await finishTrace({ PW_TRACE: 'on-failure', REPORT_DIR: dir }, before, 'failed');
    assert.deepEqual(got.sort(), [join(out, 'traces', 'trace-9.network'), join(out, 'traces', 'trace-9.trace')]);
    assert.equal(await exists(join(out, 'traces', 'screencast', 'f.jpeg')), true);
  });
  it('keeps a passed attempt when PW_TRACE=on', async () => {
    const { dir, out } = await outDir();
    const before = await snapshotFiles(out);
    await writeFile(join(out, 'traces', 't.trace'), 'x');
    assert.equal((await finishTrace({ PW_TRACE: 'on', REPORT_DIR: dir }, before, 'passed')).length, 1);
  });
  it('tolerates a missing folder', async () => {
    assert.deepEqual(await finishTrace({ PW_TRACE: 'on-failure', REPORT_DIR: '/nonexistent-xyz' }, new Set(), 'failed'), []);
  });
});

describe('orchestrator tracing', () => {
  const turn = (name: string, args: Record<string, unknown>, id: string): LlmCompleteResponse => ({ text: '', stopReason: 'tool_use', toolCalls: [{ id, name, arguments: args }] });
  async function run(outcome: 'passed' | 'failed', failStart = false) {
    const dir = await mkdtemp(join(tmpdir(), 'orch-'));
    const out = traceOutputDir({ REPORT_DIR: dir });
    const called: string[] = [];
    const cfg = {
      LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: true, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 5, AGENT_RELOOP_MAX_RETRIES: 0, AGENT_RELOOP_RETRY_ON: [],
      AGENT_RELOOP_COOLDOWN_MS: 0, REPORT_DIR: dir, D365_BASE_URL: 'https://x', D365_COMPANY: 'USMF', PW_TRACE: 'on-failure', AGENT_TOOL_TIMEOUT_MS: 5000,
    } as unknown as AppConfig;
    const turns = [turn('finish_test', { outcome }, 'f')];
    const mcp = {
      async listTools() { return []; },
      async callTool(_s: string, tool: string) {
        called.push(tool);
        if (tool === 'browser_start_tracing' && failStart) throw new Error('no devtools');
        if (tool === 'browser_start_tracing') { await mkdir(join(out, 'traces'), { recursive: true }); await writeFile(join(out, 'traces', 'trace-1.trace'), 'x'); }
        return { content: 'ok', isError: false };
      },
    };
    const orch = new AgentOrchestrator({ cfg, llm: { name: 'f', async complete() { return turns.shift()!; } }, mcp, kb: { retrieve: () => [], recipeFor: () => undefined, upsert() {}, async save() {} }, mcpServers: ['playwright', 'learn'] } as never);
    const result = await orch.runTestCase({ id: 'T', source: 'local', title: 't', steps: [{ index: 1, action: 'a' }] });
    return { result, called };
  }
  it('traces each attempt, attaches the trace to a failed one and drops it for a passed one', async () => {
    const failed = await run('failed');
    assert.deepEqual(failed.called, ['browser_start_tracing', 'browser_stop_tracing']);
    assert.equal(failed.result.artifacts.filter((a) => a.endsWith('.trace')).length, 1);
    const passed = await run('passed');
    assert.deepEqual(passed.result.artifacts, []);
  });
  it('carries on without a trace when tracing cannot start', async () => {
    const { result, called } = await run('failed', true);
    assert.deepEqual(called, ['browser_start_tracing']);
    assert.equal(result.outcome, 'failed');
  });
});
