import type { TestCase } from '../testing/types.js';

export interface RecordedStep { index: number; code: string[]; status?: string; actual?: string }
export interface CapturedVar { name: string; value: string; expression: string; step: number; at?: number }
/** Recording has its own fixed allowlist: operator tool grants do not turn arbitrary/hidden code tools into recordings. */
export const RECORDABLE_BROWSER_TOOLS = new Set([
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_take_screenshot', 'browser_click', 'browser_hover',
  'browser_type', 'browser_fill_form', 'browser_press_key', 'browser_select_option', 'browser_drag', 'browser_wait_for', 'browser_tabs',
  'browser_handle_dialog', 'browser_console_messages', 'browser_resize', 'browser_close', 'browser_find', 'browser_verify_element_visible',
  'browser_verify_list_visible', 'browser_verify_text_visible', 'browser_verify_value',
]);

export interface RecordingState {
  setup: string[];
  steps: RecordedStep[];
  vars: CapturedVar[];
  current?: number;
}

export function newRecording(tc: TestCase): RecordingState {
  return { setup: [], steps: tc.steps.map((s) => ({ index: s.index, code: [] })), vars: [] };
}

/** Only Playwright MCP's own successful result block is a source of recorded code. */
export function extractPlaywrightCode(text: string): string[] {
  const match = /###\s*Ran Playwright code\s*\n([\s\S]*?)(?=\n###\s|\s*$)/.exec(text);
  if (!match) return [];
  return match[1]
    .replace(/```(?:js|ts|javascript|typescript)?/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^\/\/\s*(?:Ran|Wait)/i.test(line.trim()));
}

export function beginRecordingStep(recording: RecordingState, tc: TestCase, index: number): boolean {
  if (!tc.steps.some((s) => s.index === index)) return false;
  recording.current = index;
  return true;
}

/** Models that do not call begin_step get a deterministic fallback: the first step without a verdict. */
export function recordingStep(recording: RecordingState, tc: TestCase, reported: Array<{ index: number }>): number | undefined {
  return recording.current ?? tc.steps.find((s) => !reported.some((r) => r.index === s.index))?.index;
}

export function appendRecording(recording: RecordingState, tc: TestCase, reported: Array<{ index: number }>, code: string[]): void {
  if (!code.length) return;
  const step = recordingStep(recording, tc, reported);
  if (step === undefined) {
    recording.setup.push(...code);
    return;
  }
  const target = recording.steps.find((s) => s.index === step);
  if (target) target.code.push(...code);
}

export function finishRecordingStep(recording: RecordingState, index: number, status: string, actual?: string): void {
  const step = recording.steps.find((s) => s.index === index);
  if (step) { step.status = status; step.actual = actual; }
  if (recording.current === index) recording.current = undefined;
}

export const CAPTURE_NAME = /^[A-Za-z_$][\w$]{0,59}$/;
export const D365_CONTROL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,119}$/;
const SECRETISH = /(?:password|passwd|secret|credential|access.?token|api.?key)/i;

export function validCaptureRequest(name: unknown, control: unknown, mode: unknown): string | undefined {
  if (typeof name !== 'string' || !CAPTURE_NAME.test(name)) return 'Capture name must be a bounded JavaScript identifier (1–60 letters, digits, _ or $).';
  if (SECRETISH.test(name)) return 'Secret-shaped capture names are refused. Never capture credentials or tokens.';
  if (typeof control !== 'string' || !D365_CONTROL_NAME.test(control)) return 'control must be a D365 data-dyn-controlname identifier (letters, digits and underscores only).';
  if (SECRETISH.test(control)) return 'Controls that appear to hold credentials or tokens cannot be captured.';
  if (mode !== 'value' && mode !== 'text') return 'mode must be "value" (inputValue) or "text" (textContent).';
  return undefined;
}

/** The only capture expression the app will execute or save: constructed here, never supplied by a model. */
export function captureExpression(control: string, mode: 'value' | 'text'): string {
  const locator = `page.getByTestId(${JSON.stringify(control)})`;
  return mode === 'value' ? `${locator}.inputValue()` : `${locator}.textContent()`;
}

/** A documented empty text value is different from a missing/null text value. */
export function captureToolCode(control: string, mode: 'value' | 'text', d365BaseUrl?: string): string {
  const expression = captureExpression(control, mode);
  const origin = d365BaseUrl ? new URL(d365BaseUrl).origin : undefined;
  const guard = origin ? `if (new URL(page.url()).origin !== ${JSON.stringify(origin)}) throw new Error('Capture is allowed only on the configured D365 origin.'); ` : '';
  return `async (page) => { ${guard}const value = await ${expression}; return value === null || value === undefined ? '' : String(value); }`;
}
