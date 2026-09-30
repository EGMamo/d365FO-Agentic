import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../config/index.js';
import type { StepStatus } from '../testing/types.js';

/**
 * Playwright traces. @playwright/mcp has no "save trace" flag; tracing is done with its
 * `browser_start_tracing` / `browser_stop_tracing` tools, which need `--caps devtools` and write
 * `traces/trace-<timestamp>.trace` (+ `.network`, screencast frames) under `--output-dir`.
 * The agent calls them itself around each attempt; the model never sees them (they are not on
 * the tool allowlist).
 */
export function traceOutputDir(cfg: Pick<AppConfig, 'REPORT_DIR'>): string {
  return join(cfg.REPORT_DIR, 'playwright-output');
}

export function tracingEnabled(cfg: Pick<AppConfig, 'PW_TRACE'>): boolean {
  return cfg.PW_TRACE === 'on' || cfg.PW_TRACE === 'on-failure';
}

/** Playwright MCP launch arguments needed for tracing. Empty when tracing is off or unset. */
export function traceLaunchArgs(cfg: Pick<AppConfig, 'PW_TRACE' | 'REPORT_DIR'>): string[] {
  return tracingEnabled(cfg) ? ['--caps', 'devtools', '--output-dir', traceOutputDir(cfg)] : [];
}

/** Every file currently under the trace output folder (empty when it does not exist yet). */
export async function snapshotFiles(dir: string): Promise<Set<string>> {
  const found = new Set<string>();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) for (const f of await snapshotFiles(full)) found.add(f);
    else found.add(full);
  }
  return found;
}

/**
 * After `browser_stop_tracing`: works out which files this attempt produced. With `on-failure` and
 * an attempt that passed (or was skipped) they are deleted and nothing is returned; otherwise the
 * `.trace` / `.network` files are returned for the report.
 */
export async function finishTrace(
  cfg: Pick<AppConfig, 'PW_TRACE' | 'REPORT_DIR'>,
  before: Set<string>,
  outcome: StepStatus,
): Promise<string[]> {
  const added = [...(await snapshotFiles(traceOutputDir(cfg)))].filter((f) => !before.has(f));
  if (cfg.PW_TRACE === 'on-failure' && (outcome === 'passed' || outcome === 'skipped')) {
    await Promise.all(added.map((f) => rm(f, { force: true })));
    return [];
  }
  return added.filter((f) => /\.(trace|network)$/i.test(f));
}
