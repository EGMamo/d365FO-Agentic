import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TestCase } from '../testing/types.js';
import { parseCodeLine } from './code.js';
import type { ReplayScript } from './store.js';

/** The @playwright/test version the exported folder installs: the Playwright that the bundled Playwright MCP runs on. */
export const PLAYWRIGHT_TEST_VERSION = '^1.64.0';

export interface ExportOptions {
  /** Saved F&O sign-in (storage state) the tests start from; overridable with D365_STORAGE_STATE when running them. */
  storageState?: string;
  actionTimeoutMs: number;
  /** Test cases by id, to name each step in the report. */
  cases?: Map<string, TestCase>;
}

export interface ExportResult {
  written: string[];
  skipped: Array<{ testCaseId: string; reason: string }>;
}

const js = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ')}'`;

/** File name for a test case id: letters, digits, dot, dash and underscore. */
export function specFileName(testCaseId: string): string {
  return `${testCaseId.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'case'}.spec.ts`;
}

/** One Playwright test for a recorded script; undefined when it holds code that is not plain recorded Playwright. */
export function specSource(script: ReplayScript, tc?: TestCase): string | undefined {
  const lines = script.steps.flatMap((s) => [...s.actions, ...s.assertions]);
  if (lines.some((l) => !parseCodeLine(l))) return undefined;
  const out = [
    "import { test, expect, type Page } from '@playwright/test';",
    '',
    `// Recorded by d365fo-agent from the passing run of ${script.recordedAt}. Re-export with \`d365fo-agent export-tests\` after the next passing run.`,
    "/** F&O shows a 'Please wait' overlay while it processes a change. */",
    'async function settle(page: Page) {',
    "  await page.getByText('Please wait').first().waitFor({ state: 'hidden' }).catch(() => {});",
    '}',
    '',
    `test(${js(`${script.testCaseId}: ${script.title}`)}, async ({ page }) => {`,
  ];
  for (const step of script.steps) {
    const tcStep = tc?.steps.find((s) => s.index === step.index);
    out.push(`  await test.step(${js(`Step ${step.index}${tcStep ? `: ${tcStep.action}` : ''}`.slice(0, 200))}, async () => {`);
    for (const a of step.actions) out.push(`    ${a}`, '    await settle(page);');
    if (tcStep?.expected && !step.assertions.length) out.push(`    // Expected: ${tcStep.expected.replace(/\r?\n/g, ' ')} (checked by reading the page in the recorded run, not recorded as an assertion)`);
    for (const a of step.assertions) out.push(`    ${a}`);
    out.push('  });');
  }
  out.push('});', '');
  return out.join('\n');
}

function configSource(opts: ExportOptions): string {
  return [
    "import { defineConfig } from '@playwright/test';",
    '',
    '// Tests exported by d365fo-agent from recorded passing runs. Run them with `npx playwright test`.',
    'export default defineConfig({',
    "  testDir: '.',",
    '  timeout: 10 * 60 * 1000,',
    '  expect: { timeout: 15000 },',
    '  workers: 1,',
    "  reporter: [['list'], ['html', { open: 'never' }]],",
    '  use: {',
    "    // F&O renders each control's AOT name in data-dyn-controlname: the names Task Recorder and RSAT use.",
    "    testIdAttribute: 'data-dyn-controlname',",
    `    actionTimeout: ${opts.actionTimeoutMs},`,
    `    storageState: process.env.D365_STORAGE_STATE || ${opts.storageState ? js(resolve(opts.storageState)) : 'undefined'},`,
    "    trace: 'retain-on-failure',",
    '  },',
    '});',
    '',
  ].join('\n');
}

const README = `# F&O tests exported by d365fo-agent

Each \`*.spec.ts\` file is the recorded path of a test case's last passing run, with the checks the agent recorded.

\`\`\`bash
npm install
npx playwright install chromium   # once, if no Playwright browser is installed
npx playwright test               # run all; add a file name to run one
npx playwright show-report        # open the HTML report
\`\`\`

The tests start from a saved F&O sign-in. \`playwright.config.ts\` points at the one the agent used; set
\`D365_STORAGE_STATE\` to use another (\`d365fo-agent session-login\` saves a fresh one).

Values typed in the recorded run are replayed as they were: a case that creates a record with a fixed id
may need fresh data. Re-export after the agent's next passing run to pick up a new path.
`;

/** Writes one spec per recorded script plus a Playwright config, package.json and README to `outDir`. */
export async function exportSpecs(scripts: ReplayScript[], outDir: string, opts: ExportOptions): Promise<ExportResult> {
  await mkdir(outDir, { recursive: true });
  const result: ExportResult = { written: [], skipped: [] };
  for (const script of scripts) {
    if (!script.steps.some((s) => s.actions.length)) {
      result.skipped.push({ testCaseId: script.testCaseId, reason: 'no recorded actions' });
      continue;
    }
    if (script.problem) {
      result.skipped.push({ testCaseId: script.testCaseId, reason: script.problem });
      continue;
    }
    const source = specSource(script, opts.cases?.get(script.testCaseId));
    if (!source) {
      result.skipped.push({ testCaseId: script.testCaseId, reason: 'the recording contains code that is not plain Playwright' });
      continue;
    }
    const file = join(outDir, specFileName(script.testCaseId));
    await writeFile(file, source, 'utf8');
    result.written.push(file);
  }
  await writeFile(join(outDir, 'playwright.config.ts'), configSource(opts), 'utf8');
  await writeFile(
    join(outDir, 'package.json'),
    `${JSON.stringify({ name: 'd365fo-exported-tests', private: true, scripts: { test: 'playwright test' }, devDependencies: { '@playwright/test': PLAYWRIGHT_TEST_VERSION } }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(outDir, 'README.md'), README, 'utf8');
  return result;
}
