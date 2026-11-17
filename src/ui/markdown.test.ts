import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// web/markdown.js is plain browser JavaScript; run it against a stand-in window.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'markdown.js'), 'utf8');
const fakeWindow: Record<string, any> = {};
new Function('window', source)(fakeWindow);
const { parseMarkdown, parseInline, renderMarkdown } = fakeWindow.chatMarkdown;

interface FakeElement {
  tag: string;
  props: Record<string, string>;
  children: Array<FakeElement | string>;
  appendChild(child: FakeElement): FakeElement;
  readonly lastElementChild: FakeElement | null;
}
const h = (tag: string, props: Record<string, string> = {}, ...children: Array<FakeElement | string>): FakeElement => ({
  tag,
  props,
  children,
  appendChild(child) {
    this.children.push(child);
    return child;
  },
  get lastElementChild() {
    return ([...this.children].reverse().find((c) => typeof c !== 'string') as FakeElement) ?? null;
  },
});
/** Compact HTML-like serialization for assertions; strings are shown as-is (they are text nodes, never markup). */
const html = (n: FakeElement | string): string =>
  typeof n === 'string' ? n : `<${n.tag}${Object.entries(n.props).map(([k, v]) => ` ${k}="${v}"`).join('')}>${n.children.map(html).join('')}</${n.tag}>`;
const render = (md: string): string => (renderMarkdown(md, h) as FakeElement[]).map(html).join('');

describe('chat markdown', () => {
  it('renders the shapes assistant answers use', () => {
    assert.equal(render('## Results\nTwo **passed**, one *failed*.'), '<h4>Results</h4><p>Two <strong>passed</strong>, one <em>failed</em>.</p>');
    assert.equal(render('- one\n- two\n  - nested\n- three'), '<ul><li>one</li><li>two<ul><li>nested</li></ul></li><li>three</li></ul>');
    assert.equal(render('3. c\n4. d'), '<ol start="3"><li>c</li><li>d</li></ol>');
    assert.equal(render('```json\n{"a": 1}\n```'), '<pre><code data-lang="json">{"a": 1}</code></pre>');
    assert.equal(render('> note\n> more'), '<blockquote><p>note<br></br>more</p></blockquote>');
    assert.equal(render('a\n\n---\n\nb'), '<p>a</p><hr></hr><p>b</p>');
  });

  it('renders tables, padding short rows and honouring escaped pipes', () => {
    assert.equal(
      render('| Case | Outcome |\n|---|:---:|\n| TC-1 | `passed` |\n| a \\| b |'),
      '<div class="md-table"><table><thead><tr><th>Case</th><th>Outcome</th></tr></thead><tbody><tr><td>TC-1</td><td><code>passed</code></td></tr><tr><td>a | b</td><td></td></tr></tbody></table></div>',
    );
  });

  it('links only http(s) addresses, and opens them outside the app', () => {
    assert.equal(render('[run](https://dev.azure.com/o/p/_testManagement/runs?runId=7)'), '<p><a href="https://dev.azure.com/o/p/_testManagement/runs?runId=7" target="_blank" rel="noopener noreferrer">run</a></p>');
    assert.equal(render('See https://example.com/x.'), '<p>See <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>.</p>');
    assert.equal(render('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
  });

  it('keeps markup in model text as text', () => {
    const blocks = renderMarkdown('<img src=x onerror=alert(1)> **<b>bold</b>**', h) as FakeElement[];
    assert.equal(blocks[0].children[0], '<img src=x onerror=alert(1)> ');
    assert.equal((blocks[0].children[1] as FakeElement).tag, 'strong');
    assert.equal((blocks[0].children[1] as FakeElement).children[0], '<b>bold</b>');
  });

  it('does not treat snake_case or arithmetic as emphasis', () => {
    assert.deepEqual(parseInline('use_profile and list_test_cases'), [{ type: 'text', text: 'use_profile and list_test_cases' }]);
    assert.deepEqual(parseInline('2 * 3 * 4'), [{ type: 'text', text: '2 * 3 * 4' }]);
    assert.deepEqual(parseInline('\\*literal\\*'), [{ type: 'text', text: '*literal*' }]);
  });

  it('copes with unclosed fences, empty input and long answers', () => {
    assert.deepEqual(parseMarkdown('```\nnot closed'), [{ type: 'code', lang: '', text: 'not closed' }]);
    assert.deepEqual(parseMarkdown(''), []);
    const long = 'word **bold** `code` '.repeat(5000);
    const started = Date.now();
    parseMarkdown(long);
    assert.ok(Date.now() - started < 1000, 'linear enough for a 100 KB answer');
  });
});
