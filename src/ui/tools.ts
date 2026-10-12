import type { TestResult } from '../testing/types.js';
import { totals } from './history.js';

/**
 * Open WebUI integration: the settings app also serves an OpenAPI tool server under `/tools`, so an Open WebUI chat
 * model can list profiles, edit test cases, start and stop runs, read results and upload them to Azure DevOps.
 * Those routes use a separate bearer token (`openwebui-token` in the agent home) instead of the browser cookie, so
 * the key pasted into Open WebUI can be rotated without signing the browser out. They never return profile values.
 */
export const TOOLS_PREFIX = '/tools';

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
      },
      '/runs': {
        post: {
          operationId: 'start_run',
          summary:
            'Start a test run with the profile in use. Use source "local" with a folder, or source "devops" with a plan id (and optional suite id). Returns at once; call get_run to follow it.',
          requestBody: jsonBody(
            obj(
              {
                source: { type: 'string', enum: ['local', 'devops'] },
                local: { ...str, description: 'Test-case folder for source "local".' },
                plan: { ...str, description: 'Azure DevOps test plan id for source "devops".' },
                suite: { ...str, description: 'Azure DevOps test suite id (optional).' },
                caseId: { ...str, description: 'Run only this test case id (optional).' },
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
          summary: 'Status of the current or last run or upload, with the end of its log. Set waitSeconds to wait for it to finish first.',
          parameters: [
            query('waitSeconds', 'Wait up to this many seconds (max 120) for a running job to finish.', { ...int, minimum: 0, maximum: 120 }),
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
          summary: 'Results of the latest run, or of a run from the history: totals and each test case with its outcome and failure reason.',
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

/** Per-case progress of a run, read from its log ("▶ Running [id] title" then "→ outcome …"). */
export function runProgress(lines: readonly string[]): { finished: number; current?: string; cases: Array<{ id: string; title: string; outcome?: string }> } {
  const cases: Array<{ id: string; title: string; outcome?: string }> = [];
  for (const line of lines) {
    const start = /^▶ Running \[(.+?)\] (.*)$/.exec(line.trim());
    if (start) {
      cases.push({ id: start[1], title: start[2] });
      continue;
    }
    const done = /^→ (passed|failed|blocked|skipped)\b/.exec(line.trim());
    const last = cases.at(-1);
    if (done && last && !last.outcome) last.outcome = done[1];
  }
  const current = cases.at(-1);
  return { finished: cases.filter((c) => c.outcome).length, ...(current && !current.outcome ? { current: `${current.id} ${current.title}` } : {}), cases };
}

/** A compact view of results.json for a chat model: totals plus one line per case. */
export function summarizeResults(results: TestResult[]): Record<string, unknown> {
  return {
    totals: totals(results),
    cases: results.map((r) => {
      const failed = r.steps?.find((s) => s.status === 'failed' || s.status === 'blocked');
      return {
        id: r.testCaseId,
        title: r.title,
        outcome: r.outcome,
        durationMs: r.durationMs,
        ...(r.attemptCount && r.attemptCount > 1 ? { attempts: r.attemptCount } : {}),
        ...(r.errorMessage || failed ? { reason: r.errorMessage ?? failed?.errorMessage ?? failed?.observed, failedStep: failed?.index } : {}),
        ...(r.data && Object.keys(r.data).length ? { data: r.data } : {}),
      };
    }),
  };
}
