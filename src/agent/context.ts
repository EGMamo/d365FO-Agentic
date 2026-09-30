import type { LlmMessage } from '../llm/types.js';

/**
 * Keeps the conversation from growing without bound. Every turn resends the whole
 * history, and F&O accessibility snapshots are large, so cost and latency grow with
 * the square of the step count. Old page snapshots are stale anyway (refs change with
 * every page update), so only the latest bulky MCP results are kept verbatim.
 *
 * Compaction runs in batches: nothing changes until more than `keepRecent * 2` bulky
 * results have piled up, then everything but the latest `keepRecent` is collapsed. The
 * history is therefore append-only between batches, which keeps the provider's prompt
 * cache prefix valid for most turns.
 */
const MIN_COMPACT_CHARS = 800;
const PREVIEW_CHARS = 160;
const STUB_PREFIX = '[Omitted older tool result';

function isBulkyMcpResult(m: LlmMessage): boolean {
  return m.role === 'tool' && !!m.toolName?.includes('__') && m.content.length >= MIN_COMPACT_CHARS && !m.content.startsWith(STUB_PREFIX);
}

function stub(m: LlmMessage): string {
  const preview = m.content.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
  return `${STUB_PREFIX} to save context: ${m.toolName}, ${m.content.length} chars. Starts with: "${preview}…" Take a fresh snapshot or repeat the call if you need it again.]`;
}

/** Collapses old bulky MCP results in place. Returns how many were collapsed. */
export function compactHistory(messages: LlmMessage[], keepRecent: number): number {
  if (keepRecent <= 0) return 0;
  const bulky: number[] = [];
  messages.forEach((m, i) => {
    if (isBulkyMcpResult(m)) bulky.push(i);
  });
  if (bulky.length <= keepRecent * 2) return 0;
  const old = bulky.slice(0, bulky.length - keepRecent);
  for (const i of old) messages[i] = { ...messages[i], content: stub(messages[i]) };
  return old.length;
}
