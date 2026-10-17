import { FAILURE_CATEGORY_HINTS, type FailureCategory } from '../testing/triage.js';
import type { TestResult } from '../testing/types.js';
import { totals } from './history.js';

/**
 * Open WebUI integration: the settings app also serves an OpenAPI tool server under `/tools`, so an Open WebUI chat
 * model can list profiles, draft, edit and delete test cases, browse Azure DevOps test plans, start and stop runs,
 * read results with their triage and upload them to Azure DevOps.
 * Those routes use a separate bearer token (`openwebui-token` in the agent home) instead of the browser cookie, so
 * the key pasted into Open WebUI can be rotated without signing the browser out. They never return profile values.
 */
export const TOOLS_PREFIX = '/tools';
/**
 * Longest get_run wait. Open WebUI and Node's fetch give up on a tool call after about 300 s, so a wait stays
 * under that; a long run is followed with a few calls of this length, each told by `next` what to do.
 */
export const MAX_WAIT_SECONDS = 240;

const str = { type: 'string' } as const;
const int = { type: 'integer' } as const;
const bool = { type: 'boolean' } as const;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const ok = (description: string) => ({ 200: { description, content: { 'application/json': { schema: { type: 'object' } } } } });
const query = (name: string, description: string, schema: unknown = str, required = false) => ({ name, in: 'query', required, description, schema });
const jsonBody = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });

const DIR = query('dir', 'Test-case folder inside the project, for example "examples/testcases".', str, true);
const TEST_CASE = obj(
  {
    id: { ...str, description: 'Optional id such as "TC-AP-001"; derived from the title when left out.' },
    title: str,
    module: { ...str, description: 'F&O module, for example "Accounts payable".' },
    legalEntity: { ...str, description: 'Company to run in, for example "USMF".' },
    tags: { type: 'array', items: str },
    steps: { type: 'array', items: obj({ action: { ...str, description: 'What to do on this step.' }, expected: { ...str, description: 'What should be true afterwards.' } }, ['action']) },
  },
  ['title', 'steps'],
);

/** The OpenAPI document Open WebUI reads to build its tools. Paths are relative to `serverUrl`. */
export function openApiSpec(serverUrl: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'D365FO test runner',
      version: '1.0.0',
      description:
        'Run Dynamics 365 Finance & Operations regression tests with the D365FO agent: pick a profile (environment), manage local test cases, start runs from a local folder or an Azure DevOps test plan, read results and upload them to Azure DevOps. Only one run happens at a time.',
    },
    servers: [{ url: serverUrl }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearer: [] }],
    paths: {
      '/profiles': {
        get: { operationId: 'list_profiles', summary: 'List the saved environment profiles and which one is in use. Setting values are never returned.', responses: ok('Profiles') },
      },
      '/profiles/active': {
        post: {
          operationId: 'use_profile',
          summary: 'Choose the profile (environment) that later runs and uploads use.',
          requestBody: jsonBody(obj({ name: { ...str, description: 'Profile name exactly as listed by list_profiles.' } }, ['name'])),
          responses: ok('The profile now in use'),
        },
      },
      '/testcases': {
        get: { operationId: 'list_test_cases', summary: 'List the local test-case files in a folder, with id, title and step count.', parameters: [DIR], responses: ok('Test cases') },
        put: {
          operationId: 'save_test_case',
          summary: 'Create a local test case, or replace one when "file" is given. Returns the file name it was saved as.',
          parameters: [DIR, query('file', 'Existing file name to replace, as listed by list_test_cases. Leave out to create a new file.')],
          requestBody: jsonBody(obj({ testCase: TEST_CASE }, ['testCase'])),
          responses: ok('Saved test case'),
        },
      },
      '/testcases/file': {
        get: {
          operationId: 'read_test_case',
          summary: 'Read one local test case with all of its steps.',
          parameters: [DIR, query('file', 'File name as listed by list_test_cases.', str, true)],
          responses: ok('Test case'),
        },
        delete: {
          operationId: 'delete_test_case',
          summary: 'Delete one local test-case file. It cannot be undone: name the file to the user and wait for them to confirm first.',
          parameters: [DIR, query('file', 'File name as listed by list_test_cases.', str, true)],
          responses: ok('The deleted file'),
        },
      },
      '/testcases/draft': {
        post: {
          operationId: 'draft_test_cases',
          summary:
            'Draft new local test cases from a plain-language description with the AI model of the profile in use, using what the agent learned about the forms. Saves them to the folder unless save is false, and returns the file names. Takes up to a few minutes. Read them back with read_test_case before running them.',
          parameters: [DIR],
          requestBody: jsonBody(
            obj(
              {
                description: { ...str, description: 'What to test, for example "create a vendor and post an invoice for it".' },
                count: { ...int, minimum: 1, maximum: 10, description: 'How many test cases to draft (default 1).' },
                module: { ...str, description: 'F&O module, for example "Accounts payable" (optional).' },
                legalEntity: { ...str, description: 'Company to test in, for example "USMF" (optional).' },
                save: { ...bool, description: 'Save the drafts as files (default true). Set false to only show them.' },
              },
              ['description'],
            ),
          ),
          responses: ok('Drafted test cases'),
        },
      },
      '/devops/plans': {
        get: {
          operationId: 'list_devops_plans',
          summary: 'List the Azure DevOps test plans of the profile in use, newest first, with the id start_run and upload_run take and the root suite id.',
          responses: ok('Test plans'),
        },
      },
      '/devops/plans/{plan}/suites': {
        get: {
          operationId: 'list_devops_suites',
          summary: 'List the suites of one Azure DevOps test plan, each with its parent suite, so a run can be limited to one suite.',
          parameters: [{ name: 'plan', in: 'path', required: true, description: 'Test plan id from list_devops_plans.', schema: str }],
          responses: ok('Test suites'),
        },
      },
      '/runs': {
        post: {
          operationId: 'start_run',
          summary:
            'Start a test run with the profile in use. Use source "local" with a folder, or source "devops" with a plan id (and optional suite id) from list_devops_plans. Returns at once; then call get_run with waitSeconds 240 and do what its "next" field says until the run has finished.',
          requestBody: jsonBody(
            obj(
              {
                source: { type: 'string', enum: ['local', 'devops'] },
                local: { ...str, description: 'Test-case folder for source "local".' },
                plan: { ...str, description: 'Azure DevOps test plan id for source "devops".' },
                suite: { ...str, description: 'Azure DevOps test suite id (optional).' },
                caseId: { ...str, description: 'Run only this test case id (optional).' },
                cases: { type: 'array', items: { type: 'string' }, description: 'Run only these test case ids (optional).' },
                model: { ...str, description: 'AI model setup (name or id) for this run only; the profile keeps its own (optional).' },
                dryRun: { ...bool, description: 'Plan the steps without changing anything in F&O.' },
                upload: { ...bool, description: 'Upload the results to Azure DevOps when the run ends.' },
                retries: { ...int, minimum: 0, maximum: 10, description: 'Re-run failed cases up to this many times.' },
              },
              ['source'],
            ),
          ),
          responses: ok('The run that started'),
        },
      },
      '/runs/current': {
        get: {
          operationId: 'get_run',
          summary:
            'Status of the current or last run or upload: progress per case, an estimate of the time left, the end of its log and, once a run has finished, its results with triage. Set waitSeconds to wait for it to finish first. Always do what the "next" field says.',
          parameters: [
            query('waitSeconds', `Wait up to this many seconds (max ${MAX_WAIT_SECONDS}) for a running job to finish; it returns as soon as the job ends.`, { ...int, minimum: 0, maximum: MAX_WAIT_SECONDS }),
            query('tail', 'How many log lines to return (default 40, max 400).', { ...int, minimum: 0, maximum: 400 }),
          ],
          responses: ok('Run status'),
        },
      },
      '/runs/current/stop': {
        post: { operationId: 'stop_run', summary: 'Stop the run that is in progress.', responses: ok('Whether a run was stopped') },
      },
      '/results': {
        get: {
          operationId: 'get_results',
          summary:
            'Results of the latest run, or of a run from the history: totals, why cases did not pass (triage category with what to do), and each test case with its outcome, failure reason, category and hint.',
          parameters: [query('run', 'Run id from list_runs. Leave out for the latest run.')],
          responses: ok('Results'),
        },
      },
      '/setup/check': {
        post: {
          operationId: 'check_setup',
          summary: 'Check the profile in use: LLM, F&O URL and sign-in, saved session, Azure DevOps and the browser. Takes up to a minute. Secrets are masked.',
          responses: ok('Check output'),
        },
      },
      '/knowledge/pages': {
        get: {
          operationId: 'list_learned_pages',
          summary: 'F&O forms the agent has learned while running tests: menu item, caption, visits, how many controls it knows there, and notes. Learned forms can be opened by caption in later runs.',
          parameters: [query('search', 'Only forms whose caption or menu item contains this text (optional).')],
          responses: ok('Learned forms'),
        },
      },
      '/history': {
        get: {
          operationId: 'list_runs',
          summary: 'List earlier runs kept in the history, newest first, with totals and Azure DevOps upload links.',
          parameters: [query('limit', 'How many runs to return (default 20).', { ...int, minimum: 1, maximum: 200 })],
          responses: ok('Runs'),
        },
      },
      '/history/{id}/upload': {
        post: {
          operationId: 'upload_run',
          summary: 'Upload a run from the history to Azure DevOps as a test run, with the profile in use. Call get_run to follow it.',
          parameters: [{ name: 'id', in: 'path', required: true, description: 'Run id from list_runs.', schema: str }],
          requestBody: jsonBody(obj({ plan: { ...str, description: 'Azure DevOps test plan id (optional; defaults to the profile setting).' } })),
          responses: ok('The upload that started'),
        },
      },
    },
  };
}

export interface RunProgress {
  finished: number;
  /** Cases the run will run, once its log has said so. */
  total?: number;
  current?: string;
  /** Rough time left, from the average time of the finished cases. */
  remainingSeconds?: number;
  cases: Array<{ id: string; title: string; outcome?: string }>;
}

/** Per-case progress of a run, read from its log ("Running N test case(s).", "▶ Running [id] title", "→ outcome … in 12.0s"). */
export function runProgress(lines: readonly string[]): RunProgress {
  const cases: Array<{ id: string; title: string; outcome?: string }> = [];
  let total: number | undefined;
  const seconds: number[] = [];
  for (const line of lines) {
    const t = line.trim();
    const count = /^Running (\d+) test case\(s\)\.$/.exec(t);
    if (count) {
      total = Number(count[1]);
      continue;
    }
    const start = /^▶ Running \[(.+?)\] (.*)$/.exec(t);
    if (start) {
      cases.push({ id: start[1], title: start[2] });
      continue;
    }
    const done = /^→ (passed|failed|blocked|skipped)\b(?:.* in ([\d.]+)s$)?/.exec(t);
    const last = cases.at(-1);
    if (done && last && !last.outcome) {
      last.outcome = done[1];
      if (done[2]) seconds.push(Number(done[2]));
    }
  }
  const current = cases.at(-1);
  const finished = cases.filter((c) => c.outcome).length;
  const left = total !== undefined ? total - finished : undefined;
  const average = seconds.length ? seconds.reduce((a, b) => a + b, 0) / seconds.length : undefined;
  return {
    finished,
    ...(total !== undefined ? { total } : {}),
    ...(current && !current.outcome ? { current: `${current.id} ${current.title}` } : {}),
    ...(left !== undefined && average !== undefined ? { remainingSeconds: Math.round(left * average) } : {}),
    cases,
  };
}

/**
 * What the chat model should do after a get_run call, in one plain sentence. Weaker models stop following a long
 * run after a call or two, so a running job always asks for the next call explicitly.
 */
export function nextStep(job: { kind: 'run' | 'upload'; status: string } | null, progress?: RunProgress, hasResults = false): string {
  if (!job) return 'Nothing has run yet. Call start_run to start one.';
  if (job.status === 'running') {
    const done = progress ? `${progress.finished}${progress.total !== undefined ? ` of ${progress.total}` : ''} case(s) finished` : 'still uploading';
    const eta = progress?.remainingSeconds !== undefined ? `, about ${Math.max(1, Math.round(progress.remainingSeconds / 60))} min left` : '';
    return `Still running (${done}${eta}). Tell the user the progress in one line, then call get_run again with waitSeconds ${MAX_WAIT_SECONDS}; do not stop following it until it has finished. The run carries on even if the chat stops.`;
  }
  if (job.kind === 'upload') return job.status === 'passed' ? 'The upload finished. Give the user the Azure DevOps link from the log.' : 'The upload did not finish. Tell the user why from the log.';
  if (job.status === 'stopped') return 'The run was stopped. Tell the user which cases finished.';
  return hasResults
    ? 'The run has finished and its results are included. Report the totals, then each case that did not pass with its reason and hint.'
    : 'The run has finished without results. Tell the user why from the log, and suggest check_setup.';
}

/** A compact view of results.json for a chat model: totals, the triage of what did not pass, and one line per case. */
export function summarizeResults(results: TestResult[]): Record<string, unknown> {
  const counts = new Map<FailureCategory, number>();
  for (const r of results) if (r.failureCategory && r.outcome !== 'passed') counts.set(r.failureCategory, (counts.get(r.failureCategory) ?? 0) + 1);
  return {
    totals: totals(results),
    ...(counts.size
      ? { triage: [...counts].sort((a, b) => b[1] - a[1]).map(([category, cases]) => ({ category, cases, hint: FAILURE_CATEGORY_HINTS[category] })) }
      : {}),
    cases: results.map((r) => {
      const failed = r.steps?.find((s) => s.status === 'failed' || s.status === 'blocked');
      return {
        id: r.testCaseId,
        title: r.title,
        outcome: r.outcome,
        durationMs: r.durationMs,
        ...(r.attemptCount && r.attemptCount > 1 ? { attempts: r.attemptCount } : {}),
        ...(r.replay ? { replay: r.replay.outcome === 'passed' ? 'replayed without the AI' : `replay failed at step ${r.replay.step}; the AI ran it` } : {}),
        ...(r.errorMessage || failed ? { reason: r.errorMessage ?? failed?.errorMessage ?? failed?.observed, failedStep: failed?.index } : {}),
        ...(r.failureCategory && r.outcome !== 'passed' ? { category: r.failureCategory, hint: FAILURE_CATEGORY_HINTS[r.failureCategory] } : {}),
        ...(r.data && Object.keys(r.data).length ? { data: r.data } : {}),
      };
    }),
  };
}

/** The JSON object a CLI command printed as its last line of standard output (`--json`), if any. */
export function cliJson(stdout: string): Record<string, unknown> | undefined {
  const last = stdout.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
  if (!last) return undefined;
  try {
    const parsed = JSON.parse(last) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The message of the error a failed CLI command printed (its stack trace left out), for a tool reply. */
export function cliError(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const thrown = lines.map((l) => /^(?:\w*Error|config): (.+)$/.exec(l)).find(Boolean);
  return (thrown?.[1] ?? lines.filter((l) => !l.startsWith('at ')).at(-1) ?? 'The command failed without a message.').slice(0, 600);
}
