import fs from 'node:fs';
import path from 'node:path';
import { resolve } from 'node:path';
import type { AppConfig } from '../config/index.js';
import type { TestCase, TestResult } from '../testing/types.js';
import { parameterTokens } from '../devops/parameters.js';
import type { CapturedVar, RecordedStep } from './recording.js';

export type { CapturedVar, RecordedStep } from './recording.js';
export type DataRow = Record<string, string>;
export type ReplayProjectConfig = Pick<AppConfig, 'D365_BASE_URL' | 'D365_STORAGE_STATE' | 'PW_BROWSER' | 'PW_HEADLESS' | 'PW_ACTION_TIMEOUT_MS'> & { AGENT_REPLAY_DIR?: string; REPORT_DIR: string };

export interface SpecInput {
  cfg: ReplayProjectConfig & { testsDir: string };
  testCase: TestCase;
  /** Data rows to save (the executed row has resolved values). */
  rows: DataRow[];
  /** Index of the row the recording used; its values are turned into data references. */
  recordedRow: number;
  executedRows?: number[];
  setup: string[];
  steps: RecordedStep[];
  vars: CapturedVar[];
  result: { outcome: TestResult['outcome']; summary: string };
}

export function replayDir(cfg: Pick<AppConfig, 'REPORT_DIR' | 'AGENT_REPLAY_DIR'>): string {
  return resolve(cfg.AGENT_REPLAY_DIR || path.join(cfg.REPORT_DIR, 'replay'));
}

export function replayProjectConfig(cfg: AppConfig): ReplayProjectConfig & { testsDir: string } {
  return { ...cfg, testsDir: replayDir(cfg) };
}

const needsLookup = (value: string | undefined): boolean => value === undefined || !value.trim() || value.trim() === '?' || /^(?:mcp|lookup|data|find)\s*:/i.test(value) || /^\{\{.*\}\}$/.test(value) || /^<\s*(?:auto|lookup|any)[^>]*>$/i.test(value);
const findParamRefs = parameterTokens;

export function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'test';
}

const isIdent = (s: string) => /^[A-Za-z_$][\w$]*$/.test(s);
const ref = (obj: string, key: string) => (isIdent(key) ? `${obj}.${key}` : `${obj}[${JSON.stringify(key)}]`);

function unescapeJs(s: string): string {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_m, e: string) => {
    if (e[0] === 'u' && e.length > 1) return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ''), 16));
    if (e[0] === 'x' && e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^(\r\n|[\r\n\u2028\u2029])$/.test(e)) return ''; // line continuation
    return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' } as any)[e] ?? e;
  });
}
const escTpl = (s: string) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

const LINE_BREAK = /[\r\n\u2028\u2029]/;

/** A piece of code: code, a comment, a '...' / "..." string, the text of a template literal, a regex or a template delimiter. */
interface Region { kind: 'code' | 'comment' | 'str' | 'text' | 'regex' | 'delim'; start: number; end: number; level: number; tpl: number }

function stringEnd(src: string, i: number): number {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j += src.startsWith('\r\n', j + 1) ? 2 : 1;
    else if (src[j] === src[i]) return j + 1;
    else if (src[j] === '\n' || src[j] === '\r') return j;
  }
  return src.length;
}

function regexEnd(src: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') j++;
    else if (LINE_BREAK.test(c)) return j;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '/') { for (j++; j < src.length && /\w/.test(src[j]); j++); return j; }
  }
  return src.length;
}

/**
 * Splits code into regions that cover it: enough of a tokenizer to find literals, comments and statement ends.
 * level = number of template expressions (${...}) around a region; tpl = start of the template literal a 'text' region is in.
 */
function scan(src: string): Region[] {
  const out: Region[] = [];
  const add = (kind: Region['kind'], start: number, end: number, level: number, tpl = -1) => { if (end > start) out.push({ kind, start, end, level, tpl }); };
  let i = 0;
  const code = (level: number): void => {
    let from = i, depth = 0, prev = '';
    while (i < src.length) {
      const c = src[i], d = src[i + 1];
      let kind: Region['kind'] | undefined;
      let end = i + 1;
      if (c === '/' && d === '/') { kind = 'comment'; while (end < src.length && !LINE_BREAK.test(src[end])) end++; }
      else if (c === '/' && d === '*') { kind = 'comment'; const e = src.indexOf('*/', i + 2); end = e < 0 ? src.length : e + 2; }
      else if (c === "'" || c === '"') { kind = 'str'; end = stringEnd(src, i); }
      else if (c === '/' && /^$|[(,=:[!&|?{};+\-*%<>~^]/.test(prev)) { kind = 'regex'; end = regexEnd(src, i); }
      else if (c === '`') kind = 'delim';
      else if (c === '}' && level > 0 && depth === 0) break; // end of the ${...} this code is in
      if (!kind) {
        if (c === '{') depth++;
        else if (c === '}') depth--;
        if (!/\s/.test(c)) prev = c;
        i++;
        continue;
      }
      add('code', from, i, level);
      if (kind === 'delim') template(level);
      else { add(kind, i, end, level); i = end; }
      if (kind !== 'comment') prev = c;
      from = i;
    }
    add('code', from, i, level);
  };
  const template = (level: number): void => {
    const tpl = i;
    add('delim', i, i + 1, level);
    let from = ++i;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { add('text', from, i, level, tpl); add('delim', i, i + 1, level); i++; return; }
      if (src[i] === '$' && src[i + 1] === '{') {
        add('text', from, i, level, tpl);
        add('delim', i, i + 2, level);
        i += 2;
        code(level + 1);
        if (i < src.length) { add('delim', i, i + 1, level); i++; }
        from = i;
        continue;
      }
      i++;
    }
    i = src.length;
    add('text', from, i, level, tpl);
  };
  code(0);
  return out;
}

// A line break ends a statement unless the statement is still open (brackets, literal, trailing operator) or the next line
// continues it (".click()", "? a : b", "else", ...).
const OPEN_END = /[([{,.=+\-*/%&|^!~?:<>]/;
const CONTINUES = /^(?:[.?)\]}([,:=+\-*%&|^<>`]|\/(?![/*])|(?:else|catch|finally)\b)/;

/** Splits recorded code into its statements (a comment line is one too), each with all of its lines. */
function statements(src: string): string[] {
  const out: string[] = [];
  let from = 0, depth = 0, last = '';
  for (const r of scan(src)) {
    if (r.level > 0 || r.kind === 'comment' || r.kind === 'text') continue;
    if (r.kind !== 'code') { last = '"'; continue; } // a literal is an operand
    for (let i = r.start; i < r.end; i++) {
      const c = src[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
      if (c === '\n' && !depth && (!last || last === ';' || !(OPEN_END.test(last) || CONTINUES.test(src.slice(i + 1).trimStart())))) {
        out.push(src.slice(from, i));
        from = i + 1;
        last = '';
      } else if (!/\s/.test(c)) last = c;
    }
  }
  out.push(src.slice(from));
  return out.filter(s => s.trim());
}

/**
 * Where each line of a statement starts: in code, inside an aria snapshot (Playwright ignores its common indentation) or
 * inside another literal, where the indentation is part of the value.
 */
function lineStarts(text: string): Array<'code' | 'aria' | 'literal'> {
  const regions = scan(text);
  const out: Array<'code' | 'aria' | 'literal'> = ['code'];
  let r = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    while (regions[r].end <= i) r++;
    const { kind, tpl } = regions[r];
    out.push(kind === 'text' ? (/\.toMatchAriaSnapshot\(\s*$/.test(text.slice(0, tpl)) ? 'aria' : 'literal') : kind === 'str' ? 'literal' : 'code');
  }
  return out;
}

/** Removes a statement's own indentation from its first line and as much from its other code lines; literal lines stay. */
function dedent(stmt: string): string {
  const lines = stmt.split('\n');
  const pad = lines[0].length - lines[0].trimStart().length;
  const starts = lineStarts(stmt);
  return lines.map((l, i) => (i === 0 ? l.trimStart() : starts[i] === 'code' ? l.slice(Math.min(pad, l.length - l.trimStart().length)) : l)).join('\n');
}

/** Indents a statement as one block, except lines that start inside a literal other than an aria snapshot. */
function indentBlock(text: string, n: number): string {
  const pad = ' '.repeat(n);
  if (!text.includes('\n')) return pad + text;
  const starts = lineStarts(text);
  return text.split('\n').map((l, i) => (starts[i] === 'literal' ? l : pad + l)).join('\n');
}

/** A recorded value and its reference (expr '' = ambiguous, the value stays literal); partial: may replace part of a literal. */
export interface Sub { value: string; expr: string; partial?: boolean }

const WORD = /[\p{L}\p{N}\p{M}]/u;
const numeric = (v: string) => /^[-+]?[\d\s.,]+$/.test(v) && /\d/.test(v);
// By default (data values) only values of 4+ characters that are not just a number are replaced inside a longer literal.
const replacesPart = (s: Sub) => s.partial ?? (s.value.length >= 4 && !numeric(s.value));

/** Where values occur in a text as whole tokens (no letter or digit right before or after), longest first, not overlapping. */
function occurrences(text: string, subs: Sub[], cuttable: (i: number) => boolean): Array<{ start: number; end: number; sub: Sub }> {
  const hits: Array<{ start: number; end: number; sub: Sub }> = [];
  for (const sub of subs) {
    if (!replacesPart(sub)) continue;
    for (let start = text.indexOf(sub.value); start >= 0; start = text.indexOf(sub.value, start + 1)) {
      const end = start + sub.value.length;
      if (WORD.test([...text.slice(Math.max(0, start - 2), start)].pop() ?? '') || WORD.test([...text.slice(end, end + 2)][0] ?? '')) continue;
      if (cuttable(start) && cuttable(end) && !hits.some(h => start < h.end && end > h.start)) hits.push({ start, end, sub });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

function substituteString(literal: string, subs: Sub[]): string {
  if (literal.length < 2 || literal[literal.length - 1] !== literal[0]) return literal;
  const content = unescapeJs(literal.slice(1, -1));
  const exact = subs.find(s => s.value === content);
  if (exact) return exact.expr || literal;
  let out = '', at = 0;
  for (const h of occurrences(content, subs, () => true)) {
    if (!h.sub.expr) continue;
    out += escTpl(content.slice(at, h.start)) + '${' + h.sub.expr + '}';
    at = h.end;
  }
  return out ? '`' + out + escTpl(content.slice(at)) + '`' : literal;
}

/** The text of a template literal: values become ${...} in place, everything else stays exactly as recorded. */
function substituteTemplateText(raw: string, subs: Sub[], whole: boolean): string {
  // The cooked text, and where each character (or escape sequence) of it starts in the raw text.
  let cooked = '';
  const rawAt = new Map<number, number>();
  for (const m of raw.matchAll(/\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])|\r\n?|[\s\S]/g)) {
    rawAt.set(cooked.length, m.index!);
    cooked += m[0][0] === '\\' ? unescapeJs(m[0]) : m[0][0] === '\r' ? '\n' : m[0];
  }
  rawAt.set(cooked.length, raw.length);
  const exact = whole ? subs.find(s => s.value === cooked) : undefined;
  if (exact) return exact.expr ? '${' + exact.expr + '}' : raw;
  let out = '', at = 0;
  for (const h of occurrences(cooked, subs, i => rawAt.has(i))) {
    if (!h.sub.expr) continue;
    out += raw.slice(at, rawAt.get(h.start)) + '${' + h.sub.expr + '}';
    at = rawAt.get(h.end)!;
  }
  return out + raw.slice(at);
}

/**
 * Replaces string literals equal to a recorded value with its reference, and a value inside a longer string or template
 * literal with ${reference}.
 */
export function substituteLiterals(code: string, subs: Sub[]): string {
  if (!subs.length) return code;
  const sorted = [...subs].sort((a, b) => b.value.length - a.value.length);
  return scan(code).map(r => {
    const text = code.slice(r.start, r.end);
    if (r.kind === 'str') return substituteString(text, sorted);
    if (r.kind === 'text') return substituteTemplateText(text, sorted, code[r.start - 1] === '`' && code[r.end] === '`');
    return text;
  }).join('');
}

const WAIT_AFTER = /\.(click|dblclick|press|selectOption|check|uncheck|setChecked)\(|page\.goto\(|page\.goBack\(/;
const WAIT = 'await waitForD365(page);';
const codeOf = (stmt: string) => scan(stmt).map(r => (r.kind === 'code' || r.kind === 'delim' ? stmt.slice(r.start, r.end) : r.kind === 'str' ? "''" : '')).join('');

/** Turns recorded code lines into the statements of the saved test; a statement spanning several lines stays one entry. */
export function transformLines(lines: string[], subs: Sub[], cfg: Pick<ReplayProjectConfig, 'D365_BASE_URL'>): string[] {
  const out: string[] = [];
  const base = (cfg.D365_BASE_URL ?? '').replace(/\/$/, '');
  for (let stmt of statements(lines.join('\n'))) {
    stmt = dedent(stmt);
    if (base) {
      // Absolute URLs on the app become relative to baseURL ("./..."), so the test runs against any environment.
      stmt = stmt.split(`page.goto('${base}/`).join(`page.goto('./`).split(`page.goto("${base}/`).join(`page.goto("./`);
      stmt = stmt.split(`page.goto('${base}'`).join(`page.goto('./'`).split(`page.goto("${base}"`).join(`page.goto("./"`);
    }
    out.push(substituteLiterals(stmt, subs));
    if (WAIT_AFTER.test(codeOf(stmt))) out.push(WAIT);
  }
  // Remove back-to-back duplicate waits.
  return out.filter((l, i) => !(l === WAIT && out[i - 1] === l));
}

const indent = (lines: string[], n: number) => lines.map(l => indentBlock(l, n));
const comment = (s: string) => s.replace(/\*\//g, '*\\/').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

export function renderSpec(input: SpecInput): string {
  const { cfg, testCase: tc, steps, vars, setup, result } = input;
  const row = input.rows[input.recordedRow] ?? {};
  const params = new Map<string, string[]>(); // value -> the parameters that have it
  for (const [k, v] of Object.entries(row)) if (v && !needsLookup(v)) params.set(v, [...(params.get(v) ?? []), k]);
  const captures = vars.map((v, i) => ({ ...v, i, at: v.at ?? Infinity }));
  // The values replaced at a point of a step (-1 = setup): data values everywhere, a captured value from where it was
  // captured until its variable is captured again. upTo: of the captures at that same point, only those before it.
  const subsAt = (step: number, at: number, upTo = Infinity): Sub[] => {
    const namedStep = tc.sourceSteps?.find(s => s.index === step) ?? tc.steps.find(s => s.index === step);
    const named = step >= 0 ? findParamRefs(`${namedStep?.action ?? ''}\n${namedStep?.expected ?? ''}`).map(p => p.toLowerCase()) : [];
    // A value of several parameters is ambiguous and stays literal, unless the step text names exactly one of them.
    const subs: Sub[] = [...params].map(([value, keys]) => {
      const pick = keys.length > 1 ? keys.filter(k => named.includes(k.toLowerCase())) : keys;
      return { value, expr: pick.length === 1 ? ref('data', pick[0]) : '' };
    });
    const latest = new Map<string, string>();
    for (const c of captures.filter(c => c.step < step || (c.step === step && (c.at < at || (c.at === at && c.i < upTo))))
      .sort((a, b) => a.step - b.step || a.at - b.at || a.i - b.i)) latest.set(c.name, c.value);
    // Captured values (document numbers and the like) are distinctive, so they may replace part of a literal even when numeric.
    for (const [name, value] of latest) if (value && !subs.some(s => s.value === value)) subs.push({ value, expr: ref('vars', name), partial: value.length >= 4 });
    return subs;
  };
  /** The statements of a step (-1 = setup), with each captured value assigned where it was captured. */
  const block = (code: string[], step: number): string[] => {
    const out: string[] = [];
    let from = 0;
    const emit = (to: number) => { if (to > from) out.push(...transformLines(code.slice(from, to), subsAt(step, from), cfg)); from = Math.max(from, to); };
    for (const c of captures.filter(c => c.step === step).sort((a, b) => a.at - b.at || a.i - b.i)) {
      emit(Math.min(c.at, code.length));
      out.push(...transformLines([`${ref('vars', c.name)} = await ${c.expression.trim().replace(/;+$/, '')};`], subsAt(step, c.at, c.i), cfg));
    }
    emit(code.length);
    return out;
  };

  const failed = result.outcome !== 'passed';
  const fileId = `TC-${slug(tc.id)}`;
  const body: string[] = [];
  body.push('const vars: Record<string, string> = {};');
  const opening = block(setup, -1);
  if (opening.length) {
    body.push(`await test.step('Open application', async () => {`);
    body.push(...indent(opening, 2));
    body.push('});');
  }
  tc.steps.forEach((s) => {
    const rec = steps.find(r => r.index === s.index);
    const title = `Step ${s.index}: ${s.action.split(LINE_BREAK)[0].slice(0, 90)}`;
    body.push('');
    body.push(`await test.step(${JSON.stringify(title)}, async () => {`);
    if (LINE_BREAK.test(s.action)) body.push(`  // Action: ${comment(s.action)}`);
    if (s.expected) body.push(`  // Expected: ${comment(s.expected)}`);
    const lines = block(rec?.code ?? [], s.index);
    if (!lines.length) lines.push(rec?.status === 'skipped' ? '// Step was skipped during recording.' : '// TODO: no browser actions were recorded for this step – add them or verify manually.');
    body.push(...indent(lines, 2));
    body.push('});');
  });

  const testFn = failed ? 'test.fixme' : 'test';
  const source = tc.source === 'devops' ? 'Azure DevOps' : 'Local';
  const annotations = [{ type: 'test-case-id', description: tc.id }, ...(tc.source === 'devops' ? [{ type: 'ado-test-case', description: tc.id }] : []), ...(tc.url ? [{ type: 'test-case-url', description: tc.url }] : [])];
  return `/**
 * ${source} test case ${comment(tc.id)}: ${comment(tc.title)}
 * Source:    ${comment(tc.url ?? 'local test case')}${tc.rev ? ` (revision ${tc.rev})` : ''}
 * Recorded:  ${new Date().toISOString()} by d365fo-agentic (allowlisted Playwright MCP calls)
 * Result:    ${result.outcome} – ${comment(result.summary).slice(0, 300)}
${failed ? ' * NOTE:      The recording did not pass or was incomplete, so this test is marked fixme. Review it before activation.\n' : ''} * Data:      ../data/${fileId}.json (one test per row)
 * Run:       npm install && npx playwright test ${path.posix.join('tests', specFileName(tc))}
 */
import { test, expect } from '@playwright/test';
import { loadData, waitForD365 } from '../support/helpers';

const rows = loadData('${fileId}');

for (const [i, data] of rows.entries()) {
  ${testFn}(\`TC ${escTpl(tc.id)}: ${escTpl(tc.title)}\${rows.length > 1 ? \` [row \${i + 1}]\` : ''}\`, {
    tag: [${tc.source === 'devops' ? `'@ado', '@ado-${tc.id}'` : `'@local'`}],
    annotation: [...${JSON.stringify(annotations)}, { type: 'iteration', description: String(i + 1) }, { type: 'iteration-count', description: String(rows.length) }],
  }, async ({ page }) => {
    void expect; void data;
${indent(body, 4).join('\n')}
  });
}
`;
}

export function specFileName(tc: TestCase): string {
  return `TC-${slug(tc.id)}-${slug(tc.title)}.spec.ts`;
}

/**
 * The rows saved to data/TC-<id>.json: every row whose values are all resolved (only those can be replayed without the
 * agent) plus the rows executed in this run. A value the agent added to the recorded row (set_parameter during the
 * run) is copied into rows that do not have it, so every replayed row has the data the recorded code reads.
 */
export function dataRows(input: Pick<SpecInput, 'rows' | 'recordedRow' | 'executedRows'>): DataRow[] {
  const executed = new Set(input.executedRows ?? [input.recordedRow]);
  const recorded = input.rows[input.recordedRow] ?? {};
  const kept = input.rows.filter((r, i) => executed.has(i) || Object.values(r).every(v => !needsLookup(v)));
  return kept.length
    ? kept.map(r => ({ ...r, ...Object.fromEntries(Object.entries(recorded).filter(([k]) => !(k in r))) }))
    : [{}];
}

export function dataFileFor(cfg: ReplayProjectConfig & { testsDir: string }, tc: TestCase): string {
  return path.join(cfg.testsDir, 'data', `TC-${slug(tc.id)}.json`);
}

/** Writes only the data file, for a row whose recording is not kept as the test. */
export function writeData(input: SpecInput): string {
  ensureTestProject(input.cfg);
  const dataFile = dataFileFor(input.cfg, input.testCase);
  fs.writeFileSync(dataFile, JSON.stringify(dataRows(input), null, 2) + '\n', 'utf8');
  return dataFile;
}

export function writeSpec(input: SpecInput): { specFile: string; dataFile: string } {
  ensureTestProject(input.cfg);
  const specFile = path.join(input.cfg.testsDir, 'tests', specFileName(input.testCase));
  // The first passing recording is authoritative. Later rows add data but cannot replace it with a failing/incomplete
  // recording; a fixme draft may be replaced by a newer draft or by the first pass.
  const existing = fs.existsSync(specFile) ? fs.readFileSync(specFile, 'utf8') : '';
  if (!existing || existing.includes('test.fixme(`TC ')) fs.writeFileSync(specFile, renderSpec(input), 'utf8');
  return { specFile, dataFile: writeData(input) };
}

const writeIfMissing = (file: string, content: string) => {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
};

/** Creates the replay project (config, helpers, package.json) once. Existing files are never overwritten. */
export function ensureTestProject(cfg: ReplayProjectConfig & { testsDir: string }): void {
  const dir = cfg.testsDir;
  for (const d of ['tests', 'data', 'support', '.auth']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const storage = cfg.D365_STORAGE_STATE ? path.relative(dir, resolve(cfg.D365_STORAGE_STATE)).split(path.sep).join('/') : '.auth/d365.json';
  writeIfMissing(path.join(dir, 'package.json'), JSON.stringify({
    name: 'd365fo-recorded-tests', private: true,
    scripts: { test: 'playwright test', report: 'playwright show-report' },
    devDependencies: { '@playwright/test': '1.64.0-alpha-1789764292000', '@types/node': '^20.19.43' },
  }, null, 2) + '\n');
  writeIfMissing(path.join(dir, '.gitignore'), '.auth/\ntest-results/\nplaywright-report/\nresults/\nnode_modules/\n');
  writeIfMissing(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', strict: false, esModuleInterop: true, resolveJsonModule: true, skipLibCheck: true, types: ['node'] } }, null, 2) + '\n');
  writeIfMissing(path.join(dir, 'playwright.config.ts'), `import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Generated by d365fo-agentic. Edit freely – it is never overwritten.
const root = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
const storageState = process.env.D365_STORAGE_STATE || path.join(root, ${JSON.stringify(storage)});

export default defineConfig({
  testDir: './tests',
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['junit', { outputFile: 'results/junit.xml' }],
    ['json', { outputFile: 'results/results.json' }],
  ],
  use: {
    // Trailing slash so recorded relative URLs ("./?cmp=USMF&mi=...") resolve under the environment URL.
    baseURL: (process.env.D365_URL || ${JSON.stringify(cfg.D365_BASE_URL ?? '')}).replace(/\\/?$/, '/'),
    testIdAttribute: 'data-dyn-controlname',
    browserName: (process.env.PW_BROWSER || ${JSON.stringify(cfg.PW_BROWSER)}) as 'chromium' | 'firefox' | 'webkit',
    headless: process.env.PW_HEADED !== '1',
    storageState: fs.existsSync(storageState) ? storageState : undefined,
    viewport: { width: 1600, height: 900 },
    actionTimeout: ${cfg.PW_ACTION_TIMEOUT_MS ?? 15000},
    navigationTimeout: 120_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
`);
  writeIfMissing(path.join(dir, 'support', 'helpers.ts'), `import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Generated by d365fo-agentic. Edit freely – it is never overwritten.

const root = typeof __dirname !== 'undefined' ? path.resolve(__dirname, '..') : process.cwd();

/** Rows saved by the agent for a test case (data/TC-<id>.json). Set D365FO_REPLAY_DATA_DIR to use another data set. */
export function loadData(name: string): Record<string, string>[] {
  const dir = process.env.D365FO_REPLAY_DATA_DIR || path.join(root, 'data');
  const file = path.join(dir, name + '.json');
  if (!fs.existsSync(file)) return [{}];
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(rows) && rows.length ? rows : [{}];
}

/**
 * Waits until Dynamics 365 Finance & Operations has finished processing (the blocking "Please wait" overlay is gone).
 * Override the selectors with D365_BUSY_SELECTORS (comma separated) if your version uses different ones.
 */
const BUSY = (process.env.D365_BUSY_SELECTORS || '#ShellBlockingDiv,#ShellProcessingDiv,.processingDialog,.busyIndicator,.progress-indicator')
  .split(',').map(s => s.trim()).filter(Boolean);

export async function waitForD365(page: Page, timeout = 120_000): Promise<void> {
  const deadline = Date.now() + timeout;
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(200);
  let idleChecks = 0;
  while (Date.now() < deadline) {
    const busy = await page.evaluate((selectors: string[]) => {
      const visible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const st = getComputedStyle(el as HTMLElement);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      return selectors.some(s => Array.from(document.querySelectorAll(s)).some(visible));
    }, BUSY).catch(() => false);
    if (!busy && ++idleChecks >= 2) return;
    if (busy) idleChecks = 0;
    await page.waitForTimeout(250);
  }
}
`);
}
