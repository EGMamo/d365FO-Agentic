/**
 * Recorded Playwright code. Every Playwright MCP action reports the code it ran, e.g.
 *
 *   ### Ran Playwright code
 *   ```js
 *   await page.getByTestId('SystemDefinedNewButton').click();
 *   await expect(page.getByTestId('VendAccount')).toHaveValue('V1');
 *   ```
 *
 * A passing run's lines are kept per test step so the case can be replayed later without the AI, and
 * exported as a Playwright test. Only lines made of locator calls with literal arguments are accepted:
 * the text comes from a tool result (and its values from the model), so nothing else is ever run.
 */

const STR = String.raw`'(?:[^'\\\n]|\\.)*'`;
const OPT_VALUE = String.raw`(?:${STR}|true|false|-?\d+)`;
const OPTS = String.raw`\{ (?:[A-Za-z]+: ${OPT_VALUE})(?:, [A-Za-z]+: ${OPT_VALUE})* \}`;
const ARG = String.raw`(?:${STR}|${OPTS}|-?\d+)`;
const ARGS = String.raw`(?:${ARG}(?:, ${ARG})?)?`;
const LOCATOR_CALL = String.raw`\.(?:getByTestId|getByRole|getByText|getByLabel|getByPlaceholder|getByTitle|getByAltText|locator|filter|nth|first|last|contentFrame)\(${ARGS}\)`;
const LOCATOR = String.raw`page(?:${LOCATOR_CALL})+`;
const STR_LIST = String.raw`\[${STR}(?:, ${STR})*\]`;

const ACTION_LINE = new RegExp(
  String.raw`^await ${LOCATOR}\.(?:click|dblclick|fill|selectOption|check|uncheck|hover|press|pressSequentially|setChecked)\((?:${ARGS}|${STR_LIST}(?:, ${OPTS})?)\);$`,
);
const KEYBOARD_LINE = new RegExp(String.raw`^await page\.keyboard\.(?:press|type)\(${STR}\);$`);
const GOTO_LINE = new RegExp(String.raw`^await page\.goto\((${STR})\);$`);
const GO_BACK_LINE = /^await page\.goBack\(\);$/;
const ASSERT_LINE = new RegExp(
  String.raw`^await expect\(${LOCATOR}\)\.(?:not\.)?(?:toBeVisible|toBeHidden|toBeChecked|toHaveValue|toHaveText|toContainText)\((?:${STR})?\);$`,
);

export type CodeLine = { kind: 'action'; code: string } | { kind: 'goto'; code: string; url: string } | { kind: 'assertion'; code: string };

/** Classifies one line of generated Playwright code; undefined when it is not something replay can run. */
export function parseCodeLine(raw: string): CodeLine | undefined {
  const code = raw.trim();
  const goto = GOTO_LINE.exec(code);
  if (goto) return { kind: 'goto', code, url: unquote(goto[1]) };
  if (ACTION_LINE.test(code) || KEYBOARD_LINE.test(code) || GO_BACK_LINE.test(code)) return { kind: 'action', code };
  if (ASSERT_LINE.test(code)) return { kind: 'assertion', code };
  return undefined;
}

/** The lines of the `### Ran Playwright code` block of a tool result, without comments and blank lines. */
export function ranCode(text: string): string[] {
  const block = /### Ran Playwright code\s*```[a-z]*\n([\s\S]*?)```/.exec(text)?.[1];
  if (!block) return [];
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'));
}

function unquote(literal: string): string {
  return literal.slice(1, -1).replace(/\\(.)/g, (_m, c: string) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c);
}

export interface RecordedStep {
  index: number;
  /** Actions and navigations, in order. */
  actions: string[];
  /** Checks of the step's expected result (from the browser_verify_* tools). */
  assertions: string[];
}

/** Tools whose results carry no code to replay: reading the page, waiting (replay waits for F&O itself). */
const NO_REPLAY = new Set(['browser_snapshot', 'browser_find', 'browser_take_screenshot', 'browser_wait_for', 'browser_console_messages', 'browser_resize']);
/** Tools whose effect cannot be replayed from code: a native dialog, other tabs, drag and drop. */
const UNREPLAYABLE = new Set(['browser_handle_dialog', 'browser_tabs', 'browser_drag', 'browser_close']);

/**
 * Collects the code of one attempt's successful browser calls. Actions belong to the step reported next
 * (`report_step`); anything that cannot be replayed marks the whole recording as not replayable, with why.
 */
export class ReplayRecorder {
  private pending: { actions: string[]; assertions: string[] } = { actions: [], assertions: [] };
  private steps = new Map<number, RecordedStep>();
  private problem?: string;

  /** A successful Playwright MCP call and its result text. */
  add(tool: string, resultText: string): void {
    if (this.problem || NO_REPLAY.has(tool)) return;
    if (UNREPLAYABLE.has(tool)) {
      this.problem = `${tool} cannot be replayed`;
      return;
    }
    for (const raw of ranCode(resultText)) {
      const line = parseCodeLine(raw);
      if (!line) {
        this.problem = `unsupported code from ${tool}: ${raw.slice(0, 120)}`;
        return;
      }
      (line.kind === 'assertion' ? this.pending.assertions : this.pending.actions).push(line.code);
    }
  }

  /** `report_step` was called: what ran since the previous report belongs to this step. */
  step(index: number): void {
    const existing = this.steps.get(index);
    if (existing) {
      existing.actions.push(...this.pending.actions);
      existing.assertions.push(...this.pending.assertions);
    } else {
      this.steps.set(index, { index, ...this.pending });
    }
    this.pending = { actions: [], assertions: [] };
  }

  /** Marks the recording as not replayable (e.g. a secret was typed). */
  reject(reason: string): void {
    this.problem ??= reason;
  }

  result(): { steps: RecordedStep[]; problem?: string } {
    const trailing = this.pending.actions.length > 0;
    return {
      steps: [...this.steps.values()].sort((a, b) => a.index - b.index),
      problem: this.problem ?? (trailing ? 'actions after the last reported step' : undefined),
    };
  }
}

export interface ReplayCodeOptions {
  /** How long to wait for F&O's "Please wait" overlay to clear after each action. */
  settleMs: number;
  /** How long an assertion may wait for the page to match. */
  expectMs: number;
}

/**
 * The function `browser_run_code_unsafe` runs for one step. It only has `page`, so `expect` is a small
 * stand-in for the matchers replay records, polling like Playwright's own until the timeout.
 * Every line was accepted by {@link parseCodeLine}.
 */
export function stepFunction(step: Pick<RecordedStep, 'actions' | 'assertions'>, opts: ReplayCodeOptions): string {
  const body = [
    ...step.actions.flatMap((code) => [code, 'await settle();']),
    ...step.assertions,
  ];
  return [
    'async (page) => {',
    `  const settle = async () => { try { await page.getByText('Please wait').first().waitFor({ state: 'hidden', timeout: ${Math.round(opts.settleMs)} }); } catch {} };`,
    '  const expect = (l) => {',
    `    const poll = async (what, check) => { const end = Date.now() + ${Math.round(opts.expectMs)}; let last; for (;;) { try { if (await check()) return; } catch (e) { last = e; } if (Date.now() > end) throw new Error(what + ' failed for ' + l + (last ? ': ' + last.message : '')); await page.waitForTimeout(250); } };`,
    '    const api = (neg) => ({',
    "      toBeVisible: () => poll(neg ? 'not.toBeVisible' : 'toBeVisible', async () => (await l.isVisible()) !== neg),",
    "      toBeHidden: () => poll(neg ? 'not.toBeHidden' : 'toBeHidden', async () => (await l.isHidden()) !== neg),",
    "      toBeChecked: () => poll(neg ? 'not.toBeChecked' : 'toBeChecked', async () => (await l.isChecked()) !== neg),",
    "      toHaveValue: (v) => poll('toHaveValue(' + JSON.stringify(v) + ')', async () => ((await l.inputValue()) === v) !== neg),",
    "      toHaveText: (v) => poll('toHaveText(' + JSON.stringify(v) + ')', async () => ((await l.innerText()).trim() === v) !== neg),",
    "      toContainText: (v) => poll('toContainText(' + JSON.stringify(v) + ')', async () => (await l.innerText()).includes(v) !== neg),",
    '    });',
    '    return { ...api(false), not: api(true) };',
    '  };',
    ...body.map((l) => `  ${l}`),
    "  return 'ok';",
    '}',
  ].join('\n');
}
