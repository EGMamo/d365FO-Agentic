import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { TestCase } from './types.js';

/**
 * Load a directory of local test-case JSON files. Each file must match the
 * `TestCase` shape (with `source` defaulted to `local`).
 */
export async function loadLocalTestCases(dir: string): Promise<TestCase[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const cases: TestCase[] = [];
  for (const e of entries) {
    if (!e.isFile() || extname(e.name).toLowerCase() !== '.json') continue;
    const raw = await readFile(join(dir, e.name), 'utf8');
    const parsed = JSON.parse(raw) as Partial<TestCase>;
    if (!parsed.title || !Array.isArray(parsed.steps)) continue;
    cases.push({
      id: parsed.id ?? e.name.replace(/\.json$/i, ''),
      source: 'local',
      title: parsed.title,
      area: parsed.area,
      module: parsed.module,
      priority: parsed.priority,
      tags: parsed.tags ?? [],
      preconditions: parsed.preconditions,
      steps: parsed.steps.map((s, i) => ({
        index: s.index ?? i + 1,
        action: s.action,
        expected: s.expected,
      })),
      legalEntity: parsed.legalEntity,
    });
  }
  return cases;
}
