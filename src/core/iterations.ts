import { applyToSteps, rowCount } from '../devops/parameters.js';
import type { TestCase } from '../testing/types.js';

/** Number of parameter rows in a case, including local and linked shared sets. */
export function iterationCount(tc: TestCase): number {
  return Math.max(1, tc.parameterData ? rowCount(tc.parameterData) : 0, tc.parameters?.rows ?? 0);
}

/** Returns an independent case for one 0-based data row, with every step substituted from that same row. */
export function testCaseForIteration(original: TestCase, row: number): TestCase {
  const count = iterationCount(original);
  const selected = Math.max(0, Math.min(Math.trunc(row), count - 1));
  if (!original.sourceSteps && !original.parameterData) return { ...original, steps: original.steps.map((s) => ({ ...s })) };
  const sourceSteps = (original.sourceSteps ?? original.steps).map((s) => ({ ...s }));
  const applied = applyToSteps(sourceSteps, original.parameterData ?? [], selected);
  const steps = applied.steps.map((s) => ({ index: s.index, action: s.action, ...(s.expected !== undefined ? { expected: s.expected } : {}) }));
  const summary = applied.summary;
  return {
    ...original,
    steps,
    sourceSteps: sourceSteps.map((s) => ({ ...s })),
    parameterData: original.parameterData?.map((s) => ({ names: [...s.names], rows: s.rows.map((r) => ({ ...r })) })),
    ...(summary ? { parameters: { ...summary, carried: [] } } : {}),
  };
}

/** Deterministic first-row default, or every row in source order for --all-iterations. */
export function iterationIndexes(tc: TestCase, all = false): number[] {
  return all ? Array.from({ length: iterationCount(tc) }, (_, i) => i) : [0];
}
