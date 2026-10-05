import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A single learned fact tied to a test-case context. Kept as plain JSON so it
 * can be inspected, committed selectively, and swapped for a vector store
 * later without breaking the agent contract.
 */
export interface KbEntry {
  id: string;
  createdAt: string;
  testCaseId?: string;
  module?: string;
  tags: string[];
  kind: 'selector' | 'recipe' | 'remediation' | 'doc';
  summary: string;
  details: string;
  successCount: number;
  failureCount: number;
}

interface KbFile {
  version: 1;
  entries: KbEntry[];
}

/**
 * Local, file-backed knowledge base. Retrieval is intentionally simple —
 * keyword scoring over titles, tags, and summaries — good enough for the MVP
 * and easy to reason about.
 */
export class KnowledgeBase {
  private data: KbFile = { version: 1, entries: [] };
  private loaded = false;

  constructor(private dir: string) {}

  private file(): string {
    return join(this.dir, 'kb.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.dir, { recursive: true });
    const path = this.file();
    if (existsSync(path)) {
      try {
        const raw = await readFile(path, 'utf8');
        this.data = JSON.parse(raw) as KbFile;
      } catch {
        this.data = { version: 1, entries: [] };
      }
    }
    this.loaded = true;
  }

  async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(), JSON.stringify(this.data, null, 2), 'utf8');
  }

  all(): KbEntry[] {
    return [...this.data.entries];
  }

  /** Add an entry, merging with an existing one that has the same summary. */
  upsert(entry: Omit<KbEntry, 'id' | 'createdAt' | 'successCount' | 'failureCount'> & Partial<Pick<KbEntry, 'successCount' | 'failureCount'>>): KbEntry {
    const existing = this.data.entries.find(
      (e) => e.kind === entry.kind && e.summary.trim().toLowerCase() === entry.summary.trim().toLowerCase(),
    );
    if (existing) {
      existing.details = entry.details || existing.details;
      existing.tags = Array.from(new Set([...(existing.tags ?? []), ...entry.tags]));
      existing.successCount += entry.successCount ?? 0;
      existing.failureCount += entry.failureCount ?? 0;
      return existing;
    }
    const created: KbEntry = {
      id: `kb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      successCount: entry.successCount ?? 0,
      failureCount: entry.failureCount ?? 0,
      ...entry,
    };
    this.data.entries.push(created);
    return created;
  }

  /** The recorded path of the last passing run of a test case, if one was saved. */
  recipeFor(testCaseId: string): KbEntry | undefined {
    return this.data.entries.find((e) => e.kind === 'recipe' && e.testCaseId === testCaseId && e.summary === knownPathSummary(testCaseId));
  }

  /** Retrieve top-K entries most relevant to a free-text query and tag set. */
  retrieve(query: string, tags: string[] = [], k = 5): KbEntry[] {
    const terms = tokenize(query);
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    return this.data.entries
      .filter((e) => !(e.testCaseId && e.summary === knownPathSummary(e.testCaseId)))
      .map((e) => ({ entry: e, score: score(e, terms, tagSet) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.entry);
  }
}

/** Summary under which a test case's known-good path is stored, so each case keeps one entry. */
export function knownPathSummary(testCaseId: string): string {
  return `Known-good path for test case ${testCaseId}`;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function score(entry: KbEntry, terms: string[], tagSet: Set<string>): number {
  const haystack = tokenize(`${entry.summary} ${entry.details} ${entry.tags.join(' ')} ${entry.module ?? ''}`);
  const bag = new Set(haystack);
  let s = 0;
  for (const t of terms) if (bag.has(t)) s += 1;
  for (const tag of entry.tags) if (tagSet.has(tag.toLowerCase())) s += 2;
  const successBias = Math.log10(1 + entry.successCount) - Math.log10(1 + entry.failureCount);
  return s + successBias;
}
