import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compactHistory } from './context.js';
import type { LlmMessage } from '../llm/types.js';

const big = (label: string) => `### Page state\n- ${label}\n${'- button "Item" [ref=e1]\n'.repeat(60)}`;
const tool = (name: string, content: string, id: string): LlmMessage => ({ role: 'tool', toolName: name, toolCallId: id, content });

/** n assistant/tool pairs of bulky Playwright results. */
function history(n: number): LlmMessage[] {
  const out: LlmMessage[] = [{ role: 'user', content: 'Run the test' }];
  for (let i = 1; i <= n; i++) {
    out.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'playwright__browser_snapshot', arguments: {} }] });
    out.push(tool('playwright__browser_snapshot', big(`snapshot ${i}`), `c${i}`));
  }
  return out;
}

const isStub = (m: LlmMessage) => m.content.startsWith('[Omitted older tool result');

describe('compactHistory', () => {
  it('does nothing until results pile up past twice the keep window', () => {
    const msgs = history(6);
    assert.equal(compactHistory(msgs, 3), 0);
    assert.ok(!msgs.some(isStub));
  });

  it('then collapses everything except the latest keepRecent results', () => {
    const msgs = history(7);
    assert.equal(compactHistory(msgs, 3), 4);
    const tools = msgs.filter((m) => m.role === 'tool');
    assert.deepEqual(tools.map(isStub), [true, true, true, true, false, false, false]);
    assert.match(tools[6].content, /snapshot 7/);
  });

  it('keeps the message structure and tool-call pairing intact', () => {
    const msgs = history(7);
    const before = msgs.map((m) => [m.role, m.toolCallId, m.toolName]);
    compactHistory(msgs, 3);
    assert.deepEqual(msgs.map((m) => [m.role, m.toolCallId, m.toolName]), before);
  });

  it('leaves a short preview and the original size in the stub', () => {
    const msgs = history(7);
    const original = msgs[2].content.length;
    compactHistory(msgs, 3);
    assert.match(msgs[2].content, new RegExp(`playwright__browser_snapshot, ${original} chars`));
    assert.match(msgs[2].content, /Starts with: "### Page state - snapshot 1/);
    assert.ok(msgs[2].content.length < 500);
  });

  it('is idempotent and stable between batches (append-only)', () => {
    const msgs = history(7);
    compactHistory(msgs, 3);
    const snapshot = JSON.stringify(msgs);
    assert.equal(compactHistory(msgs, 3), 0);
    assert.equal(JSON.stringify(msgs), snapshot);
    msgs.push(...history(2).slice(1));
    assert.equal(compactHistory(msgs, 3), 0, 'five full results is still within the window');
  });

  it('never touches small results, local tools, assistant text or the task prompt', () => {
    const msgs = history(7);
    msgs.splice(2, 0, tool('report_step', 'x'.repeat(2000), 'r1'), tool('playwright__browser_click', 'ok', 'k1'));
    compactHistory(msgs, 3);
    assert.equal(msgs.find((m) => m.toolCallId === 'r1')?.content, 'x'.repeat(2000));
    assert.equal(msgs.find((m) => m.toolCallId === 'k1')?.content, 'ok');
    assert.equal(msgs[0].content, 'Run the test');
  });

  it('is disabled by keepRecent 0', () => {
    const msgs = history(30);
    assert.equal(compactHistory(msgs, 0), 0);
    assert.ok(!msgs.some(isStub));
  });

  it('keeps growth bounded over a long run', () => {
    const msgs: LlmMessage[] = [{ role: 'user', content: 'go' }];
    let peak = 0;
    for (let i = 1; i <= 60; i++) {
      msgs.push({ role: 'assistant', content: '', toolCalls: [] }, tool('playwright__browser_snapshot', big(`s${i}`), `c${i}`));
      compactHistory(msgs, 3);
      peak = Math.max(peak, msgs.filter((m) => m.role === 'tool' && !isStub(m)).length);
    }
    assert.ok(peak <= 6, `at most 2x keepRecent full results, saw ${peak}`);
  });
});
