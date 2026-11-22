import { applyParameters } from '../devops/parameters.js';
import type { TestCase, TestResult } from '../testing/types.js';

/**
 * Values an earlier case of the same run created, for a later case that needs them (case 39 needs
 * @PurchaseRequisitionNumber, the number case 38 created). Kept in memory for one run only, so a value can never be
 * stale; taken only from cases that passed; matched by parameter name, ignoring case, spaces and underscores.
 *
 * Order for any value a step needs: the test case's own parameter values first (they are already in the steps when
 * this runs), then a value carried over from an earlier case, then F&O, and otherwise the step is blocked.
 */
export interface CarriedValue {
  /** The name as the earlier case recorded it, without a leading @. */
  name: string;
  value: string;
  /** The test case that created it. */
  from: string;
}

export type CarriedValues = Map<string, CarriedValue>;

/** `@Purchase_Requisition Number`, `PurchaseRequisitionNumber` and `purchaserequisitionnumber` are one name. */
export const carryKey = (name: string): string => name.replace(/^@/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Remembers what a finished case recorded. Nothing from a case that did not pass, or was interrupted. A later value of the same name wins. */
export function rememberValues(carried: CarriedValues, result: Pick<TestResult, 'testCaseId' | 'outcome' | 'interrupted' | 'data'>): void {
  if (result.outcome !== 'passed' || result.interrupted) return;
  for (const [name, value] of Object.entries(result.data ?? {})) {
    const key = carryKey(name);
    if (key && value) carried.set(key, { name: name.replace(/^@/, ''), value, from: result.testCaseId });
  }
}

/**
 * Fills the parameters a case still has no value for with what earlier cases of the run created. A parameter that
 * already has a value (from the test case) is never touched. Returns the case unchanged when nothing applies.
 */
export function applyCarriedValues(tc: TestCase, carried: CarriedValues): { tc: TestCase; used: Array<{ name: string; from: string }> } {
  const open = tc.parameters?.unresolved ?? [];
  const values: Record<string, string> = {};
  const used: Array<{ name: string; from: string }> = [];
  for (const name of open) {
    const c = carried.get(carryKey(name));
    if (!c) continue;
    values[name] = c.value;
    used.push({ name, from: c.from });
  }
  if (!used.length || !tc.parameters) return { tc, used: [] };
  const filled = new Set(used.map((u) => u.name));
  return {
    used,
    tc: {
      ...tc,
      steps: tc.steps.map((s) => ({ ...s, action: applyParameters(s.action, values), ...(s.expected === undefined ? {} : { expected: applyParameters(s.expected, values) }) })),
      ...(tc.preconditions ? { preconditions: applyParameters(tc.preconditions, values) } : {}),
      parameters: {
        ...tc.parameters,
        filled: [...tc.parameters.filled, ...filled],
        unresolved: open.filter((n) => !filled.has(n)),
        carried: [...(tc.parameters.carried ?? []), ...used],
      },
    },
  };
}
