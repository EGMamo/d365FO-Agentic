import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestResult } from '../testing/types.js';

/**
 * Keeps a copy of every finished run's reports under `<report dir>/history/<run id>/` so the UI can list earlier
 * runs, reopen their reports and upload any of them to Azure DevOps later. The CLI itself keeps writing the latest
 * reports to the report folder, unchanged.
 */
export const REPORT_FILES = ['results.json', 'report.html', 'results.junit.xml'] as const;
export type ReportFile = (typeof REPORT_FILES)[number];
const RUN_ID = /^\d{8}-\d{6}-\d{1,6}$/;
const MAX_KEPT = 200;

export interface RunMeta {
  id: string;
  status: string;
  args: string[];
  /** The profile the run belongs to (display name when it ran) and its permanent id. Uploads use this profile. */
  profile?: string | null;
  profileId?: string | null;
  /** The AI model setup the run used. */
  model?: string | null;
  modelId?: string | null;
  mode?: 'dry-run' | 'live';
  /** Where the run was started: the app or the terminal. */
  origin?: 'app' | 'cli';
  startedAt: string;
  finishedAt?: string;
  totals?: { total: number; passed: number; failed: number; blocked: number; skipped: number };
  upload?: { runId?: number; url?: string; at: string };
}

export const isRunId = (id: string): boolean => RUN_ID.test(id);

export function runId(startedAt: string, seq: number): string {
  const d = new Date(startedAt);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${seq}`;
}

export function totals(results: TestResult[]): NonNullable<RunMeta['totals']> {
  const count = (o: string) => results.filter((r) => r.outcome === o).length;
  return { total: results.length, passed: count('passed'), failed: count('failed'), blocked: count('blocked'), skipped: count('skipped') };
}

export class RunHistory {
  constructor(private readonly reportDir: () => Promise<string>) {}

  private async dir(): Promise<string> {
    return join(await this.reportDir(), 'history');
  }

  historyDir(): Promise<string> {
    return this.dir();
  }

  /**
   * Copies the reports a run just wrote. Reports older than the run's start are not its own (the run failed
   * before writing any), so only the metadata is kept then.
   */
  async record(meta: Omit<RunMeta, 'id' | 'totals'>, seq: number): Promise<RunMeta> {
    const src = await this.reportDir();
    const id = runId(meta.startedAt, seq);
    const dest = join(await this.dir(), id);
    await mkdir(dest, { recursive: true });
    const started = new Date(meta.startedAt).getTime();
    let full: RunMeta = { ...meta, id };
    for (const f of REPORT_FILES) {
      try {
        if ((await stat(join(src, f))).mtimeMs + 1000 < started) continue;
        await copyFile(join(src, f), join(dest, f));
        if (f === 'results.json') full = { ...full, totals: totals(JSON.parse(await readFile(join(dest, f), 'utf8')) as TestResult[]) };
      } catch {
        /* the run wrote no such report */
      }
    }
    await writeFile(join(dest, 'meta.json'), JSON.stringify(full, null, 2));
    await this.prune();
    return full;
  }

  async list(): Promise<RunMeta[]> {
    let names: string[];
    try {
      names = (await readdir(await this.dir())).filter(isRunId);
    } catch {
      return [];
    }
    const out: RunMeta[] = [];
    for (const n of names) {
      const m = await this.meta(n);
      if (m) out.push(m);
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async meta(id: string): Promise<RunMeta | undefined> {
    if (!isRunId(id)) return undefined;
    try {
      return JSON.parse(await readFile(join(await this.dir(), id, 'meta.json'), 'utf8')) as RunMeta;
    } catch {
      return undefined;
    }
  }

  async update(id: string, patch: Partial<RunMeta>): Promise<void> {
    const m = await this.meta(id);
    if (!m) return;
    await writeFile(join(await this.dir(), id, 'meta.json'), JSON.stringify({ ...m, ...patch, id }, null, 2));
  }

  /** Absolute path of one of a run's report files, if it exists. */
  async file(id: string, name: ReportFile): Promise<string | undefined> {
    if (!isRunId(id) || !REPORT_FILES.includes(name)) return undefined;
    const p = join(await this.dir(), id, name);
    try {
      await stat(p);
      return p;
    } catch {
      return undefined;
    }
  }

  async delete(id: string): Promise<boolean> {
    if (!isRunId(id)) return false;
    await rm(join(await this.dir(), id), { recursive: true, force: true });
    return true;
  }

  private async prune(): Promise<void> {
    const all = await this.list();
    for (const old of all.slice(MAX_KEPT)) await this.delete(old.id);
  }
}

/**
 * Runs of every profile together. Each profile keeps its own report folder (`reports/<profile id>`), so the app, which
 * shows the runs of all profiles, reads them all; a run is found by its id in whichever folder holds it.
 */
export class HistoryIndex {
  /**
   * Each folder's runs, kept while its history folder is unchanged: a new or deleted run changes the folder's mtime,
   * and changes made through this index (update, delete) drop the cache. Saves reading every meta.json per request.
   */
  private cache = new Map<string, { mtimeMs: number; at: number; runs: RunMeta[] }>();
  /** A run written from the terminal changes files inside a run folder too, so a cached list is also re-read after this long. */
  static readonly TTL_MS = 15_000;

  constructor(private readonly reportDirs: () => Promise<string[]>) {}

  private async each(): Promise<RunHistory[]> {
    return [...new Set(await this.reportDirs())].map((d) => new RunHistory(async () => d));
  }

  private async runsOf(h: RunHistory): Promise<RunMeta[]> {
    const dir = await h.historyDir();
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(dir)).mtimeMs;
    } catch {
      this.cache.delete(dir);
      return [];
    }
    const hit = this.cache.get(dir);
    if (hit && hit.mtimeMs === mtimeMs && Date.now() - hit.at < HistoryIndex.TTL_MS) return hit.runs;
    const runs = await h.list();
    this.cache.set(dir, { mtimeMs, at: Date.now(), runs });
    return runs;
  }

  /** Forget cached lists, for example when a run has just been saved. */
  invalidate(): void {
    this.cache.clear();
  }

  async list(): Promise<RunMeta[]> {
    const seen = new Set<string>();
    const out: RunMeta[] = [];
    for (const h of await this.each()) {
      for (const m of await this.runsOf(h)) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push(m);
      }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private async holder(id: string): Promise<RunHistory | undefined> {
    if (!isRunId(id)) return undefined;
    for (const h of await this.each()) if ((await this.runsOf(h)).some((m) => m.id === id) || (await h.meta(id))) return h;
    return undefined;
  }

  async meta(id: string): Promise<RunMeta | undefined> {
    return (await this.holder(id))?.meta(id);
  }

  async file(id: string, name: ReportFile): Promise<string | undefined> {
    return (await this.holder(id))?.file(id, name);
  }

  async update(id: string, patch: Partial<RunMeta>): Promise<void> {
    const h = await this.holder(id);
    if (!h) return;
    await h.update(id, patch);
    this.cache.delete(await h.historyDir());
  }

  async delete(id: string): Promise<boolean> {
    const h = await this.holder(id);
    if (!h) return false;
    this.cache.delete(await h.historyDir());
    return h.delete(id);
  }

  /** The run before this one in the same environment that has results, for a comparison. */
  async previous(id: string): Promise<RunMeta | undefined> {
    const all = await this.list();
    const at = all.findIndex((m) => m.id === id);
    if (at < 0) return undefined;
    const me = all[at];
    const owner = me.profileId ?? me.profile ?? null;
    for (const m of all.slice(at + 1)) {
      if ((m.profileId ?? m.profile ?? null) === owner && m.totals?.total && (await this.file(m.id, 'results.json'))) return m;
    }
    return undefined;
  }
}
