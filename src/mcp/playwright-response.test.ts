import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formCaption, isFnoLoading, isMissingTarget, isSnapshotRef, menuItemOf, pageInfo, ranLocators, responseText, slimSnapshot } from './playwright-response.js';

// Shapes copied from @playwright/mcp 0.0.83 responses (run against a page with data-dyn-controlname attributes).
const CLICK = [
  '### Ran Playwright code',
  '```js',
  "await page.getByTestId('SystemDefinedNewButton').click();",
  '```',
  '### Page',
  '- Page URL: https://fo.sandbox.operations.dynamics.com/?cmp=USMF&mi=VendTableListPage',
  '- Page Title: All vendors -- Finance and Operations',
  '### Snapshot',
  '- [Snapshot](.playwright-mcp/page-1.yml)',
].join('\n');

describe('Playwright MCP response parsing', () => {
  it('reads the page URL, title, menu item and form caption', () => {
    const info = pageInfo(CLICK);
    assert.deepEqual(info, { url: 'https://fo.sandbox.operations.dynamics.com/?cmp=USMF&mi=VendTableListPage', title: 'All vendors -- Finance and Operations' });
    assert.equal(menuItemOf(info?.url), 'VendTableListPage');
    assert.equal(formCaption(info?.title), 'All vendors');
    assert.equal(menuItemOf('https://x/?mi=bad%26cmp'), undefined);
    assert.equal(pageInfo('no page section'), undefined);
  });

  it('recognises the F&O loading screen: on the F&O host with no page title yet', () => {
    const base = 'https://fo.sandbox.operations.dynamics.com';
    const splash = '### Page\n- Page URL: https://fo.sandbox.operations.dynamics.com/?cmp=USMF&mi=VendTableListPage\n- Console: 2 errors';
    assert.equal(isFnoLoading(splash, base), true);
    assert.equal(isFnoLoading(splash, 'fo.sandbox.operations.dynamics.com'), true);
    assert.equal(isFnoLoading(CLICK, base), false);
    assert.equal(isFnoLoading('### Page\n- Page URL: https://login.microsoftonline.com/x/oauth2/authorize', base), false);
    assert.equal(isFnoLoading('{"ok":true}', base), false);
    assert.equal(isFnoLoading(splash, undefined), false);
  });

  it('extracts the locator each action resolved to, skipping refs and positional locators', () => {
    assert.deepEqual(ranLocators(CLICK), ["getByTestId('SystemDefinedNewButton')"]);
    const fill = "### Ran Playwright code\n```js\nawait page.getByRole('textbox', { name: 'Vendor account' }).fill('V1');\nawait page.getByRole('button').nth(2).click();\n```";
    assert.deepEqual(ranLocators(fill), ["getByRole('textbox', { name: 'Vendor account' })"]);
    assert.deepEqual(ranLocators("### Ran Playwright code\n```js\nawait page.goto('https://x');\n```"), []);
  });

  it('flattens text parts of an MCP result and recognises refs and missing targets', () => {
    assert.equal(responseText([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }]), 'a\nb');
    assert.equal(responseText('plain'), 'plain');
    assert.ok(isSnapshotRef('e12') && isSnapshotRef('f1e3') && !isSnapshotRef("getByTestId('X')"));
    assert.ok(isMissingTarget('Error: "getByTestId(\'X\')" does not match any elements.'));
    assert.ok(!isMissingTarget('Error: timeout'));
  });

  it('drops anonymous wrapper nodes from inline snapshots only', () => {
    const snap = '### Snapshot\n```yaml\n- generic [ref=e1]:\n  - toolbar [ref=e2]:\n    - button "New" [ref=e3]\n  - generic [ref=e6]:\n    - generic [ref=e7]: Please wait\n    - textbox "Name" [ref=e10]\n```';
    const slim = slimSnapshot(snap);
    assert.doesNotMatch(slim, /generic \[ref=e1\]:\n|generic \[ref=e6\]:\n/);
    assert.match(slim, /button "New" \[ref=e3\]/);
    assert.match(slim, /generic \[ref=e7\]: Please wait/, 'a wrapper with text is kept');
    assert.equal(slimSnapshot('- generic [ref=e1]:'), '- generic [ref=e1]:', 'text outside a yaml block is untouched');
  });
});
