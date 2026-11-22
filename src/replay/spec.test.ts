import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type { AppConfig } from '../config/index.js';
import type { TestCase } from '../testing/types.js';
import { ensureTestProject, renderSpec, substituteLiterals, writeSpec } from './spec.js';

const cfgAt = (testsDir: string): AppConfig & { testsDir: string } => ({
  testsDir,
  D365_BASE_URL: 'https://contoso.example/app',
  D365_STORAGE_STATE: undefined,
  PW_BROWSER: 'chromium',
  PW_HEADLESS: true,
  PW_ACTION_TIMEOUT_MS: 15000,
} as AppConfig & { testsDir: string });

const testCase = (): TestCase => ({
  id: '1234', source: 'devops', title: 'Create `order` ${now}', rev: 3,
  url: 'https://dev.azure.com/contoso/ERP/_workitems/edit/1234',
  steps: [{ index: 1, action: 'Enter @Customer', expected: 'Order is shown' }],
  sourceSteps: [{ index: 1, action: 'Enter @Customer', expected: 'Order is shown' }],
});

describe('standalone Playwright codegen', () => {
  it('substitutes strings/templates without corrupting multiline aria snapshots and uses environment-relative URLs', () => {
    const aria = [
      "await page.goto('https://contoso.example/app/?mi=SalesTable');",
      "await expect(page.locator('body')).toMatchAriaSnapshot(`",
      '- list:',
      '  - listitem: "Order for US-001"',
      '`);',
    ];
    const text = renderSpec({
      cfg: cfgAt('unused'), testCase: testCase(), rows: [{ Customer: 'US-001' }], recordedRow: 0,
      setup: [], steps: [{ index: 1, code: aria }], vars: [], result: { outcome: 'passed', summary: 'ok' },
    });
    assert.match(text, /page\.goto\('\.\/\?mi=SalesTable'\)/);
    assert.match(text, /await waitForD365\(page\);/);
    assert.ok(text.includes('  - listitem: "Order for ${data.Customer}"'));
    assert.match(text, /annotation: \[\.\.\./);
    assert.match(text, /testIdAttribute|data-dyn-controlname|loadData/);
    assert.equal(substituteLiterals("page.getByText('prefix US-001 suffix')", [{ value: 'US-001', expr: 'data.Customer' }]), 'page.getByText(`prefix ${data.Customer} suffix`)');
    assert.equal(substituteLiterals("page.getByText('US-0010')", [{ value: 'US-001', expr: 'data.Customer' }]), "page.getByText('US-0010')");
  });

  it('places app-generated captures in the spec and marks unsuccessful recordings fixme', () => {
    const text = renderSpec({
      cfg: cfgAt('unused'), testCase: testCase(), rows: [{}], recordedRow: 0, setup: [],
      steps: [{ index: 1, code: ["await expect(page.getByText('SO-000752')).toBeVisible();"] }],
      vars: [{ name: 'salesOrderId', value: 'SO-000752', expression: "page.getByTestId('SalesTable_SalesId').inputValue()", step: 1, at: 0 }],
      result: { outcome: 'blocked', summary: 'unverified' },
    });
    assert.match(text, /test\.fixme\(`TC 1234/);
    assert.match(text, /vars\.salesOrderId = await page\.getByTestId\('SalesTable_SalesId'\)\.inputValue\(\);/);
    assert.match(text, /getByText\(vars\.salesOrderId\)/);
  });

  it('writes a compilable project, preserves edited config/helpers, and uses npm-installable pinned dependencies', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'd365-codegen-'));
    const cfg = cfgAt(dir);
    const files = writeSpec({
      cfg, testCase: testCase(), rows: [{ Customer: 'US-001' }, { Customer: 'US-002' }], recordedRow: 0,
      setup: [], steps: [{ index: 1, code: ["await page.getByLabel('Customer').fill('US-001');", "await expect(page.getByText('US-001')).toBeVisible();"] }], vars: [],
      result: { outcome: 'passed', summary: 'ok' },
    });
    assert.ok(files.specFile.endsWith('.spec.ts'));
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    assert.equal(pkg.devDependencies['@playwright/test'], '1.64.0-alpha-1789764292000');
    assert.equal(JSON.parse(await readFile(files.dataFile, 'utf8')).length, 2);
    await writeFile(path.join(dir, 'support', 'helpers.ts'), '// user edited\n');
    await writeFile(path.join(dir, 'playwright.config.ts'), '// user config\n');
    ensureTestProject(cfg);
    assert.equal(await readFile(path.join(dir, 'support', 'helpers.ts'), 'utf8'), '// user edited\n');
    assert.equal(await readFile(path.join(dir, 'playwright.config.ts'), 'utf8'), '// user config\n');

    // Restore generated helpers only for this isolated compilation fixture, then type-check the real emitted spec.
    await writeFile(path.join(dir, 'support', 'helpers.ts'), `import type { Page } from '@playwright/test';
export function loadData(name: string): Record<string, string>[] { return [{ Customer: name }]; }
export async function waitForD365(page: Page): Promise<void> { await page.waitForLoadState(); }
`);
    const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
    const program = ts.createProgram([files.specFile, path.join(dir, 'support', 'helpers.ts')], {
      noEmit: true, strict: false, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true, skipLibCheck: true, types: ['node'],
      typeRoots: [path.resolve('node_modules', '@types')], baseUrl: dir,
      paths: { '@playwright/test': [path.resolve('node_modules', '@playwright', 'test', 'index.d.ts')] },
    });
    const errors = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
    assert.deepEqual(errors, []);
  });
});
