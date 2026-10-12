import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  /** Last time the entry was added to or confirmed. Missing on entries written by older versions. */
  updatedAt?: string;
  testCaseId?: string;
  module?: string;
  tags: string[];
  kind: 'selector' | 'recipe' | 'remediation' | 'doc';
  summary: string;
  details: string;
  successCount: number;
  failureCount: number;
  /** Failures since the last success. A known-good path that failed twice in a row is no longer offered. */
  consecutiveFailures?: number;
}

export type KbEntryInput = Omit<KbEntry, 'id' | 'createdAt' | 'updatedAt' | 'successCount' | 'failureCount' | 'consecutiveFailures'> &
  Partial<Pick<KbEntry, 'successCount' | 'failureCount'>>;

interface KbFile {
  version: 1;
  entries: KbEntry[];
}

export interface KbScoredEntry {
  entry: KbEntry;
  score: number;
}

export interface KbStats {
  total: number;
  byKind: Record<string, number>;
  byModule: Record<string, number>;
  knownPaths: number;
  staleKnownPaths: number;
}

export interface KbPruneOptions {
  /** Drop entries that failed at least this many times and more often than they succeeded (default 3). */
  minFailures?: number;
  /** Drop entries never confirmed by a passing run and not updated for this many days (default: keep). */
  maxAgeDays?: number;
  now?: Date;
}

/** Consecutive failures after which a known-good path is considered stale and no longer offered to the agent. */
export const STALE_PATH_FAILURES = 2;

const KINDS = new Set<KbEntry['kind']>(['selector', 'recipe', 'remediation', 'doc']);

/**
 * Local, file-backed knowledge base. Retrieval ranks entries with BM25 over a
 * D365-aware tokenizer (light stemming, common abbreviations and synonyms),
 * boosted by matching tags and module and by the entry's track record.
 */
export class KnowledgeBase {
  private data: KbFile = { version: 1, entries: [] };
  private loaded = false;
  private saving: Promise<void> = Promise.resolve();
  /** Ids on disk when this process last read or wrote the file, and ids it removed: what a merge needs to tell new from deleted. */
  private syncedIds = new Set<string>();
  private removedIds = new Set<string>();

  constructor(private dir: string) {}

  private file(): string {
    return join(this.dir, 'kb.json');
  }

  /**
   * Loads `kb.json`. A file that cannot be parsed is moved aside to `kb.json.corrupt-<time>`, and a file with
   * entries that cannot be used is copied to `kb.json.invalid-<time>` before those entries are dropped, so the
   * next save does not silently erase what was learned. A warning says what happened.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.dir, { recursive: true });
    const path = this.file();
    if (existsSync(path)) {
      const raw = await readFile(path, 'utf8');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try {
        const { entries, dropped } = normalizeEntries(JSON.parse(raw));
        this.data = { version: 1, entries };
        if (dropped > 0) {
          const backup = `${path}.invalid-${stamp}`;
          const kept = await copyFile(path, backup).then(() => true, () => false);
          console.warn(`[kb] ${dropped} entr${dropped === 1 ? 'y' : 'ies'} in ${path} had no valid kind or summary and ${dropped === 1 ? 'was' : 'were'} dropped; ${kept ? `the original file was copied to ${backup}` : 'the original file could not be backed up and will be overwritten on the next save'}.`);
        }
      } catch (e) {
        const backup = `${path}.corrupt-${stamp}`;
        const moved = await rename(path, backup).then(() => true, () => false);
        console.warn(`[kb] ${path} could not be read (${(e as Error).message}); ${moved ? `moved it to ${backup} and started empty` : 'it could not be moved aside, so the next save will overwrite it; started empty'}.`);
        this.data = { version: 1, entries: [] };
      }
    }
    this.syncedIds = new Set(this.data.entries.map((e) => e.id));
    this.loaded = true;
  }

  /**
   * Writes atomically (temp file + rename) and one save at a time, so a crash never leaves a half-written file.
   * What another process (a second run, the settings app, `learn --prune`) wrote since this one last read the
   * file is merged in first, so two writers do not erase each other's entries.
   */
  async save(): Promise<void> {
    const next = this.saving.then(async () => {
      await mkdir(this.dir, { recursive: true });
      await this.mergeFromDisk();
      const tmp = `${this.file()}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
        await renameWithRetry(tmp, this.file());
        this.syncedIds = new Set(this.data.entries.map((e) => e.id));
        this.removedIds.clear();
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw e;
      }
    });
    this.saving = next.catch(() => undefined);
    return next;
  }

  /**
   * Brings in what is on disk now: entries another process added are kept, entries it removed are dropped here
   * too, and for an entry both sides have, the more recently updated one wins. Entries this process removed stay
   * removed. A file that cannot be read is left out of the merge.
   */
  private async mergeFromDisk(): Promise<void> {
    let disk: KbEntry[];
    try {
      disk = normalizeEntries(JSON.parse(await readFile(this.file(), 'utf8'))).entries;
    } catch {
      return;
    }
    const diskIds = new Set(disk.map((e) => e.id));
    this.data.entries = this.data.entries.filter((e) => diskIds.has(e.id) || !this.syncedIds.has(e.id));
    const mine = new Map(this.data.entries.map((e) => [e.id, e]));
    const key = (e: KbEntry): string => `${e.kind}\u0000${e.summary.trim().toLowerCase()}`;
    const mineByKey = new Set(this.data.entries.map(key));
    for (const d of disk) {
      if (this.removedIds.has(d.id)) continue;
      const m = mine.get(d.id);
      if (m) {
        if ((d.updatedAt ?? '') > (m.updatedAt ?? '')) Object.assign(m, d);
      } else if (!mineByKey.has(key(d))) {
        this.data.entries.push(d);
      }
    }
  }

  all(): KbEntry[] {
    return [...this.data.entries];
  }

  /**
   * Add an entry, merging with an existing one that has the same kind and summary. A known-good path whose
   * actions changed is a new path: its track record starts over.
   */
  upsert(entry: KbEntryInput): KbEntry {
    const now = new Date().toISOString();
    const success = entry.successCount ?? 0;
    const failure = entry.failureCount ?? 0;
    const existing = this.data.entries.find(
      (e) => e.kind === entry.kind && e.summary.trim().toLowerCase() === entry.summary.trim().toLowerCase(),
    );
    if (existing) {
      const newPath = isKnownPath(existing) && Boolean(entry.details) && entry.details !== existing.details;
      if (newPath) {
        existing.successCount = 0;
        existing.failureCount = 0;
        existing.consecutiveFailures = 0;
      }
      existing.details = entry.details || existing.details;
      existing.tags = Array.from(new Set([...(existing.tags ?? []), ...(entry.tags ?? [])]));
      if (entry.module && !existing.module) existing.module = entry.module;
      existing.successCount += success;
      existing.failureCount += failure;
      if (success > 0) existing.consecutiveFailures = 0;
      else if (failure > 0) existing.consecutiveFailures = (existing.consecutiveFailures ?? 0) + failure;
      existing.updatedAt = now;
      return existing;
    }
    const created: KbEntry = {
      id: `kb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      updatedAt: now,
      ...entry,
      tags: entry.tags ?? [],
      successCount: success,
      failureCount: failure,
      consecutiveFailures: success > 0 ? 0 : failure,
    };
    this.data.entries.push(created);
    return created;
  }

  /**
   * The recorded path of the last passing run of a test case, if one was saved and it has not gone stale
   * (failed {@link STALE_PATH_FAILURES} times in a row, e.g. after the UI changed).
   */
  recipeFor(testCaseId: string): KbEntry | undefined {
    const entry = this.data.entries.find((e) => e.kind === 'recipe' && e.testCaseId === testCaseId && e.summary === knownPathSummary(testCaseId));
    return entry && !isStale(entry) ? entry : undefined;
  }

  /**
   * Records whether entries offered to a run helped: a pass credits them, a failure counts against them.
   * Returns how many entries were updated.
   */
  recordOutcome(ids: string[], passed: boolean): number {
    const now = new Date().toISOString();
    let n = 0;
    for (const id of new Set(ids)) {
      const e = this.data.entries.find((x) => x.id === id);
      if (!e) continue;
      if (passed) {
        e.successCount++;
        e.consecutiveFailures = 0;
      } else {
        e.failureCount++;
        e.consecutiveFailures = (e.consecutiveFailures ?? 0) + 1;
      }
      e.updatedAt = now;
      n++;
    }
    return n;
  }

  /** Retrieve top-K entries most relevant to a free-text query, tag set and module. */
  retrieve(query: string, tags: string[] = [], k = 5, module?: string): KbEntry[] {
    return this.search(query, tags, k, module).map((x) => x.entry);
  }

  /** Like {@link retrieve}, with the relevance score of each hit. */
  search(query: string, tags: string[] = [], k = 5, module?: string): KbScoredEntry[] {
    const terms = Array.from(new Set(tokenize(query)));
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    const mod = module?.trim().toLowerCase();
    const docs = this.data.entries
      .filter((e) => !isKnownPath(e))
      .map((e) => ({ entry: e, tokens: tokenize(`${e.summary} ${e.summary} ${e.details} ${e.tags.join(' ')}`) }));
    if (!docs.length) return [];
    const avgLen = docs.reduce((s, d) => s + d.tokens.length, 0) / docs.length || 1;
    const df = new Map<string, number>();
    for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1);

    return docs
      .map(({ entry, tokens }) => {
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        let relevance = 0;
        for (const t of terms) {
          const f = tf.get(t);
          if (!f) continue;
          const n = df.get(t) ?? 0;
          const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
          relevance += (idf * f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * tokens.length) / avgLen));
        }
        // Tag and module only lift entries whose text matches: sharing a module is not relevance on its own.
        if (relevance <= 0) return { entry, score: 0 };
        for (const tag of entry.tags) if (tagSet.has(tag.toLowerCase())) relevance += 1.5;
        if (mod && entry.module?.trim().toLowerCase() === mod) relevance += 1;
        const trackRecord = Math.log10(1 + entry.successCount) - Math.log10(1 + entry.failureCount);
        return { entry, score: relevance + 0.5 * trackRecord };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, k));
  }

  /** Removes entries with a poor track record (and optionally old, never-confirmed ones). Returns what was removed. */
  prune(opts: KbPruneOptions = {}): KbEntry[] {
    const minFailures = opts.minFailures ?? 3;
    const now = (opts.now ?? new Date()).getTime();
    const maxAgeMs = opts.maxAgeDays !== undefined ? opts.maxAgeDays * 86_400_000 : undefined;
    const removed: KbEntry[] = [];
    this.data.entries = this.data.entries.filter((e) => {
      const unreliable = e.failureCount >= minFailures && e.failureCount > e.successCount;
      const stalePath = isKnownPath(e) && isStale(e);
      const age = now - new Date(e.updatedAt ?? e.createdAt).getTime();
      const old = maxAgeMs !== undefined && e.successCount === 0 && age > maxAgeMs;
      if (unreliable || stalePath || old) {
        removed.push(e);
        this.removedIds.add(e.id);
        return false;
      }
      return true;
    });
    return removed;
  }

  stats(): KbStats {
    const byKind: Record<string, number> = {};
    const byModule: Record<string, number> = {};
    let knownPaths = 0;
    let staleKnownPaths = 0;
    for (const e of this.data.entries) {
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      const m = e.module ?? '(none)';
      byModule[m] = (byModule[m] ?? 0) + 1;
      if (isKnownPath(e)) {
        knownPaths++;
        if (isStale(e)) staleKnownPaths++;
      }
    }
    return { total: this.data.entries.length, byKind, byModule, knownPaths, staleKnownPaths };
  }
}

/** Windows refuses to rename over a file another process has open; a short retry gets past a reader or scanner. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 3 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Summary under which a test case's known-good path is stored, so each case keeps one entry. */
export function knownPathSummary(testCaseId: string): string {
  return `Known-good path for test case ${testCaseId}`;
}

function isKnownPath(e: KbEntry): boolean {
  return Boolean(e.testCaseId) && e.summary === knownPathSummary(e.testCaseId!);
}

function isStale(e: KbEntry): boolean {
  return (e.consecutiveFailures ?? 0) >= STALE_PATH_FAILURES;
}

/** Keeps the entries that can be used, with every field coerced to its type; `dropped` counts the rest. */
function normalizeEntries(parsed: unknown): { entries: KbEntry[]; dropped: number } {
  const list = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) throw new Error('expected { "version": 1, "entries": [...] }');
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const entries = list
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object')
    .filter((e) => typeof e.summary === 'string' && Boolean(e.summary.trim()) && KINDS.has(e.kind as KbEntry['kind']))
    .map((e): KbEntry => {
      const createdAt = str(e.createdAt) ?? new Date(0).toISOString();
      const module = str(e.module);
      const testCaseId = str(e.testCaseId);
      return {
        id: str(e.id) ?? `kb_${Math.random().toString(36).slice(2, 10)}`,
        kind: e.kind as KbEntry['kind'],
        summary: e.summary as string,
        details: typeof e.details === 'string' ? e.details : '',
        tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === 'string') : [],
        ...(module ? { module } : {}),
        ...(testCaseId ? { testCaseId } : {}),
        createdAt,
        updatedAt: str(e.updatedAt) ?? createdAt,
        successCount: count(e.successCount),
        failureCount: count(e.failureCount),
        consecutiveFailures: count(e.consecutiveFailures),
      };
    });
  return { entries, dropped: list.length - entries.length };
}

/** Short D365 F&O abbreviations, expanded before short tokens are dropped. */
const ABBREVIATIONS: Record<string, string> = {
  po: 'purchase order',
  ap: 'accounts payable',
  ar: 'accounts receivable',
  gl: 'general ledger',
  le: 'legal entity',
  fa: 'fixed asset',
  ui: 'user interface',
  qty: 'quantity',
  acct: 'account',
  num: 'number',
  vend: 'vendor',
  cust: 'customer',
};

/** Abbreviations that are also ordinary words: expanded only when written in capitals ("SO", not "so"). */
const CAPITAL_ABBREVIATIONS: Record<string, string> = {
  SO: 'sales order',
};

/** Words that mean the same thing in F&O test cases, mapped to one canonical stem. */
const SYNONYMS: Record<string, string> = {
  supplier: 'vendor',
  client: 'customer',
  company: 'entity',
  dataarea: 'entity',
  add: 'create',
  new: 'create',
  insert: 'create',
  remove: 'delete',
  erase: 'delete',
  modify: 'edit',
  change: 'edit',
  updat: 'edit',
  update: 'edit',
  click: 'select',
  choos: 'select',
  choose: 'select',
  pick: 'select',
  screen: 'page',
  form: 'page',
  grid: 'list',
  lookup: 'dropdown',
  combobox: 'dropdown',
  confirm: 'verify',
  check: 'verify',
  validat: 'verify',
  validate: 'verify',
  assert: 'verify',
  sign: 'login',
  logon: 'login',
  signin: 'login',
};

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'are', 'was', 'its', 'has', 'have', 'not', 'but', 'you', 'your', 'when', 'all', 'any', 'can', 'should', 'will', 'must', 'test', 'case', 'step']);

/** Light English stemmer: enough to match "orders"/"order", "posting"/"posted"/"post", "entries"/"entry". */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && (w.endsWith('ies') || w.endsWith('ied'))) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
  const before = w;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  // "running" -> "runn" -> "run", "stopped" -> "stop"; real doubles ("fill", "pass", "add") are kept.
  if (w !== before && w.length >= 4 && w.at(-1) === w.at(-2) && !'lsfz'.includes(w.at(-1)!)) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const word of s.replace(/[^A-Za-z0-9\s]/g, ' ').split(/\s+/)) {
    if (!word) continue;
    const raw = word.toLowerCase();
    const expanded = CAPITAL_ABBREVIATIONS[word] ?? ABBREVIATIONS[raw] ?? raw;
    for (const part of expanded.split(' ')) {
      if (part.length <= 2 || STOPWORDS.has(part)) continue;
      const base = SYNONYMS[part] ?? part;
      const stemmed = stem(base);
      // A synonym found only after stemming ("added" -> "add" -> "create") is stemmed too, so it meets "add" -> "creat".
      out.push(SYNONYMS[stemmed] ? stem(SYNONYMS[stemmed]) : stemmed);
    }
  }
  return out;
}
