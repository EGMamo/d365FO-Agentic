import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestCase } from '../testing/types.js';
import type { RecordedStep } from './code.js';

/**
 * Recorded scripts of passing runs, one per test case, in `<KB_DIR>/replays.json`. A case whose script covers
 * every step and has a recorded check for every expected result is replayed without the AI on the next run;
 * when the replay fails, the AI runs the case as usual and a pass records a fresh script.
 */
export const REPLAY_FILE = 'replays.json';

/** Replays that failed this many times in a row are not tried again until a passing run records a new script. */
export const STALE_REPLAY_FAILURES = 2;

export interface ReplayScript {
  testCaseId: string;
  title: string;
  recordedAt: string;
  /** Fingerprint of the test case's steps when recorded: an edited case is not replayed from an old script. */
  stepsHash: string;
  steps: RecordedStep[];
  /** Why the recording cannot be replayed, if it cannot (it is still kept to show and export what it can). */
  problem?: string;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastReplayedAt?: string;
}

interface ReplayFile {
  version: 1;
  scripts: Record<string, ReplayScript>;
}

export function stepsHash(tc: Pick<TestCase, 'steps' | 'legalEntity'>): string {
  const basis = JSON.stringify({ le: tc.legalEntity ?? '', steps: tc.steps.map((s) => [s.index, s.action, s.expected ?? '']) });
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

/** Why this script cannot replace an AI run of the case now, or undefined when it can. */
export function replayBlocker(script: ReplayScript | undefined, tc: TestCase): string | undefined {
  if (!script) return 'no recorded script';
  if (script.problem) return `the recording cannot be replayed (${script.problem})`;
  if (script.stepsHash !== stepsHash(tc)) return 'the test case changed since it was recorded';
  if (script.consecutiveFailures >= STALE_REPLAY_FAILURES) return `the replay failed ${script.consecutiveFailures} times in a row`;
  const recorded = new Map(script.steps.map((s) => [s.index, s]));
  const missing = tc.steps.filter((s) => !recorded.has(s.index)).map((s) => s.index);
  if (missing.length) return `step ${missing.join(', ')} ${missing.length > 1 ? 'were' : 'was'} not reported in the recorded run`;
  const unchecked = tc.steps.filter((s) => s.expected && !recorded.get(s.index)!.assertions.length).map((s) => s.index);
  if (unchecked.length) return `the expected result of step ${unchecked.join(', ')} was checked by reading the page, not with a recorded check`;
  if (!script.steps.some((s) => s.actions.length || s.assertions.length)) return 'the recording has no actions';
  return undefined;
}

export class ReplayStore {
  constructor(private readonly dir: string) {}

  private file(): string {
    return join(this.dir, REPLAY_FILE);
  }

  async all(): Promise<ReplayScript[]> {
    return Object.values((await this.read()).scripts).sort((a, b) => a.testCaseId.localeCompare(b.testCaseId));
  }

  async get(testCaseId: string): Promise<ReplayScript | undefined> {
    return (await this.read()).scripts[testCaseId];
  }

  /** Stores the recording of a passing run, replacing the case's previous one. */
  async record(tc: TestCase, steps: RecordedStep[], problem?: string): Promise<ReplayScript> {
    const script: ReplayScript = {
      testCaseId: tc.id,
      title: tc.title,
      recordedAt: new Date().toISOString(),
      stepsHash: stepsHash(tc),
      steps,
      ...(problem ? { problem } : {}),
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
    };
    await this.update((f) => {
      f.scripts[tc.id] = script;
    });
    return script;
  }

  /** Counts a replay's outcome against the case's script. */
  async recordOutcome(testCaseId: string, passed: boolean): Promise<void> {
    await this.update((f) => {
      const s = f.scripts[testCaseId];
      if (!s) return;
      if (passed) {
        s.successCount++;
        s.consecutiveFailures = 0;
      } else {
        s.failureCount++;
        s.consecutiveFailures++;
      }
      s.lastReplayedAt = new Date().toISOString();
    });
  }

  private async read(): Promise<ReplayFile> {
    if (!existsSync(this.file())) return { version: 1, scripts: {} };
    try {
      const parsed = JSON.parse(await readFile(this.file(), 'utf8')) as Partial<ReplayFile>;
      const scripts = parsed && typeof parsed.scripts === 'object' && parsed.scripts ? parsed.scripts : {};
      const valid = Object.fromEntries(Object.entries(scripts).filter(([, s]) => isScript(s)));
      return { version: 1, scripts: valid };
    } catch (e) {
      console.warn(`[replay] ${this.file()} could not be read (${(e as Error).message}); recorded scripts are ignored until the next passing run rewrites it.`);
      return { version: 1, scripts: {} };
    }
  }

  /** Read, change and write back, so runs of other cases in other processes are not overwritten. */
  private async update(change: (f: ReplayFile) => void): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const data = await this.read();
    change(data);
    const tmp = `${this.file()}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await rename(tmp, this.file());
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }
}

function isScript(s: unknown): s is ReplayScript {
  const x = s as ReplayScript;
  return Boolean(x) && typeof x.testCaseId === 'string' && typeof x.stepsHash === 'string' && Array.isArray(x.steps) &&
    x.steps.every((st) => typeof st?.index === 'number' && Array.isArray(st.actions) && Array.isArray(st.assertions));
}
