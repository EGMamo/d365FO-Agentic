import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TestCase } from '../testing/types.js';
import { parseCodeLine, ranCode, ReplayRecorder, stepFunction } from './code.js';
import { exportSpecs, specFileName, specSource } from './export.js';
import { replayBlocker, ReplayStore, STALE_REPLAY_FAILURES, stepsHash, type ReplayScript } from './store.js';

const ran = (...lines: string[]) => `### Ran Playwright code\n\`\`\`js\n${lines.join('\n')}\n\`\`\`\n### Page\n- Page URL: https://x`;

// Lines as @playwright/mcp 0.0.82 writes them (captured from a real run).
const REAL = [
  "await page.goto('https://fo.sandbox.operations.dynamics.com/?cmp=USMF&mi=VendTableListPage');",
  "await page.getByRole('button', { name: 'New' }).click();",
  "await page.getByTestId('VendAccount').fill('O\\'Neil');",
  "await page.getByTestId('Grp').selectOption('B');",
  "await page.getByTestId('OnHold').check();",
  "await page.keyboard.press('Tab');",
  "await expect(page.getByText('Saved V1')).toBeVisible();",
  "await expect(page.getByRole('heading', { name: 'Vendors' })).toBeVisible();",
  "await expect(page.getByTestId('VendAccount')).toHaveValue('O\\'Neil');",
  "await expect(page.getByTestId('OnHold')).toBeChecked();",
];

const tc: TestCase = {
  id: 'TC-9',
  source: 'local',
  title: 'Create vendor',
  steps: [
    { index: 1, action: 'Open vendors' },
    { index: 2, action: 'Create vendor V1', expected: 'Vendor V1 is saved' },
  ],
};

const script = (over: Partial<ReplayScript> = {}): ReplayScript => ({
  testCaseId: tc.id,
  title: tc.title,
  recordedAt: '2026-10-14T00:00:00.000Z',
  stepsHash: stepsHash(tc),
  steps: [
    { index: 1, actions: [REAL[0]], assertions: [] },
    { index: 2, actions: [REAL[1], REAL[2]], assertions: [REAL[6]] },
  ],
  successCount: 0,
  failureCount: 0,
  consecutiveFailures: 0,
  ...over,
});

describe('recorded Playwright code', () => {
  it('accepts the code Playwright MCP writes for actions, navigation and checks', () => {
    assert.deepEqual(REAL.map((l) => parseCodeLine(l)?.kind), ['goto', 'action', 'action', 'action', 'action', 'action', 'assertion', 'assertion', 'assertion', 'assertion']);
    assert.equal((parseCodeLine(REAL[0]) as { url: string }).url, 'https://fo.sandbox.operations.dynamics.com/?cmp=USMF&mi=VendTableListPage');
    assert.equal(parseCodeLine("await page.locator('iframe').contentFrame().getByRole('textbox', { name: 'Name', exact: true }).fill('x');")?.kind, 'action');
    assert.equal(parseCodeLine("await page.getByTestId('Grp').selectOption(['A', 'B']);")?.kind, 'action');
  });

  it('refuses anything else, so recorded text can never run other code', () => {
    for (const line of [
      "await page.getByTestId('x').click(); require('child_process');",
      "await page.getByTestId('x').fill('a' + process.env.SECRET);",
      'await page.getByTestId(`x`).click();',
      "await page.evaluate(() => fetch('https://evil'));",
      "await page.getByTestId('x').fill('a'); await page.goto('https://evil');",
      "await page.getByTestId('x').click({ position: { x: 1, y: 2 } });",
      "await page.context().newPage();",
      "await page.goto('https://x' + y);",
      "await (async (page) => {})(page);",
    ]) {
      assert.equal(parseCodeLine(line), undefined, line);
    }
  });

  it('reads the code block of a tool result without comments', () => {
    assert.deepEqual(ranCode(ran('// Press Tab', "await page.keyboard.press('Tab');")), ["await page.keyboard.press('Tab');"]);
    assert.deepEqual(ranCode('### Page\n- Page URL: x'), []);
  });

  it('files actions and checks under the step reported next', () => {
    const r = new ReplayRecorder();
    r.add('browser_navigate', ran(REAL[0]));
    r.add('browser_snapshot', ran("await page.whatever('ignored');"));
    r.step(1);
    r.add('browser_click', ran(REAL[1]));
    r.add('browser_verify_text_visible', ran(REAL[6]));
    r.step(2);
    assert.deepEqual(r.result(), { steps: script().steps.map((s) => (s.index === 2 ? { ...s, actions: [REAL[1]] } : s)), problem: undefined });
  });

  it('marks a recording it cannot replay, and says why', () => {
    const dialog = new ReplayRecorder();
    dialog.add('browser_handle_dialog', 'ok');
    assert.match(dialog.result().problem ?? '', /browser_handle_dialog/);
    const odd = new ReplayRecorder();
    odd.add('browser_click', ran("await page.mouse.click(10, 20);"));
    assert.match(odd.result().problem ?? '', /unsupported code/);
    const trailing = new ReplayRecorder();
    trailing.step(1);
    trailing.add('browser_click', ran(REAL[1]));
    assert.match(trailing.result().problem ?? '', /after the last reported step/);
  });

  it('builds a step function that waits for F&O after each action, then runs the checks', () => {
    const fn = stepFunction({ actions: [REAL[1]], assertions: [REAL[6]] }, { settleMs: 1000, expectMs: 2000 });
    assert.match(fn, /^async \(page\) => \{/);
    assert.ok(fn.indexOf(REAL[1]) < fn.indexOf('await settle();') && fn.indexOf('await settle();') < fn.lastIndexOf(REAL[6]));
    assert.doesNotThrow(() => new Function(`return (${fn});`));
  });
});

describe('when a recording can be replayed', () => {
  it('replays a recording that covers every step and checks every expected result', () => {
    assert.equal(replayBlocker(script(), tc), undefined);
  });

  it('does not replay a missing, changed, failing, partial or unchecked recording', () => {
    assert.match(replayBlocker(undefined, tc)!, /no recorded script/);
    assert.match(replayBlocker(script(), { ...tc, steps: [...tc.steps, { index: 3, action: 'Close' }] })!, /changed/);
    assert.match(replayBlocker(script({ consecutiveFailures: STALE_REPLAY_FAILURES }), tc)!, /failed 2 times/);
    assert.match(replayBlocker(script({ problem: 'browser_tabs cannot be replayed' }), tc)!, /browser_tabs/);
    assert.match(replayBlocker(script({ steps: [script().steps[0]], stepsHash: stepsHash(tc) }), tc)!, /step 2 was not reported/);
    assert.match(replayBlocker(script({ steps: [script().steps[0], { index: 2, actions: [REAL[1]], assertions: [] }] }), tc)!, /expected result of step 2/);
  });

  it('keeps one recording per case and counts replays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'replays-'));
    const store = new ReplayStore(dir);
    await store.record(tc, script().steps);
    await store.recordOutcome(tc.id, false);
    await store.recordOutcome(tc.id, false);
    assert.match(replayBlocker(await store.get(tc.id), tc)!, /failed 2 times/);
    await store.recordOutcome(tc.id, true);
    const s = (await store.get(tc.id))!;
    assert.deepEqual([s.successCount, s.failureCount, s.consecutiveFailures], [1, 2, 0]);
    await store.record(tc, script().steps);
    assert.deepEqual([(await store.get(tc.id))!.failureCount, (await store.all()).length], [0, 1], 'a new passing run starts a fresh record');
  });
});

describe('exporting recordings as Playwright tests', () => {
  it('writes a test with a step per test step, F&O waits and the recorded checks', () => {
    const src = specSource(script(), tc)!;
    assert.match(src, /import \{ test, expect, type Page \} from '@playwright\/test';/);
    assert.match(src, /test\('TC-9: Create vendor', async \(\{ page \}\) => \{/);
    assert.match(src, /await test\.step\('Step 2: Create vendor V1', async \(\) => \{\n {4}await page\.getByRole\('button', \{ name: 'New' \}\)\.click\(\);\n {4}await settle\(page\);/);
    assert.match(src, /await expect\(page\.getByText\('Saved V1'\)\)\.toBeVisible\(\);/);
  });

  it('notes an expected result that was checked by reading the page instead of an assertion', () => {
    const src = specSource(script({ steps: [script().steps[0], { index: 2, actions: [REAL[1]], assertions: [] }] }), tc)!;
    assert.match(src, /\/\/ Expected: Vendor V1 is saved \(checked by reading the page/);
  });

  it('writes the specs with a config that uses the F&O control names and the saved sign-in', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-'));
    const res = await exportSpecs([script(), script({ testCaseId: 'TC/10', problem: 'browser_tabs cannot be replayed' })], dir, { storageState: '/s/state.json', actionTimeoutMs: 15000, cases: new Map([[tc.id, tc]]) });
    assert.deepEqual(res.written, [join(dir, 'TC-9.spec.ts')]);
    assert.deepEqual(res.skipped, [{ testCaseId: 'TC/10', reason: 'browser_tabs cannot be replayed' }]);
    const config = await readFile(join(dir, 'playwright.config.ts'), 'utf8');
    assert.match(config, /testIdAttribute: 'data-dyn-controlname'/);
    assert.match(config, /storageState: process\.env\.D365_STORAGE_STATE \|\| '[^']*state\.json'/);
    assert.match(await readFile(join(dir, 'package.json'), 'utf8'), /"@playwright\/test"/);
    assert.equal(specFileName('../a b'), '_a_b.spec.ts');
  });
});
