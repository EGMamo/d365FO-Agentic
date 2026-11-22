import type { TestResult } from '../testing/types.js';

/**
 * Parameter values the agent chose from F&O for a case that then passed, to suggest saving to the Azure DevOps test
 * case's parameter values so the next run needs no lookup. Nothing is saved without the user's say-so.
 */
export interface ParameterSuggestion {
  caseId: string;
  title: string;
  values: NonNullable<TestResult['suggestedParameters']>;
}

/** Cases that passed and chose values, with an Azure DevOps work item id (a local case has none to save to). */
export function parameterSuggestions(results: TestResult[], onlyCases?: string[]): ParameterSuggestion[] {
  return results
    .filter((r) => !r.interrupted && r.outcome === 'passed' && /^\d+$/.test(r.testCaseId) && r.suggestedParameters?.length)
    .filter((r) => !onlyCases?.length || onlyCases.includes(r.testCaseId))
    .map((r) => ({ caseId: r.testCaseId, title: r.title, values: r.suggestedParameters! }));
}

/** One line per value, grouped by case, for the terminal and the app. */
export function describeSuggestions(list: ParameterSuggestion[]): string[] {
  return list.flatMap((s) => [
    `Case ${s.caseId} (${s.title.length > 70 ? `${s.title.slice(0, 70)}…` : s.title}):`,
    ...s.values.map((v) => `  @${v.name} = ${v.value}  (${v.source === 'odata' ? 'read from F&O' : 'chosen by the agent'}${v.how ? `; ${v.how}` : ''})`),
  ]);
}
