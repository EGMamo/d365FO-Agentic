import type { AppConfig } from '../config/index.js';

/**
 * Per-attempt run limits that stop a test from burning time and tokens on something that cannot succeed:
 * a path that does not exist, a sign-in that needs a person, a loop, or a budget that is spent.
 * Pure helpers plus a small stateful tracker, so the orchestrator only has to ask "may I continue?".
 */

export const DEFAULT_TEST_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_MAX_TOKENS_PER_TEST = 1_000_000;
export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
export const DEFAULT_MAX_UNREACHABLE_TARGETS = 3;

export type StopReason = 'unreachable' | 'auth' | 'timeout' | 'budget' | 'errors';

export interface RunStop {
  reason: StopReason;
  message: string;
  /** Running the whole test again cannot change this, so the reloop is skipped. */
  retryable: boolean;
}

type GuardConfig = Partial<
  Pick<
    AppConfig,
    | 'AGENT_TEST_TIMEOUT_MS'
    | 'AGENT_MAX_TOKENS_PER_TEST'
    | 'AGENT_MAX_CONSECUTIVE_ERRORS'
    | 'AGENT_MAX_UNREACHABLE_TARGETS'
    | 'AGENT_STOP_ON_AUTH_FAILURE'
    | 'AGENT_ALLOW_DESTRUCTIVE'
  >
>;

const MFA_PATTERN =
  /approve sign[- ]in request|\benter code\b|verify your identity|more information required|open your authenticator|authenticator app|help us protect your account|number matching|we texted your phone|stay signed in\?.*verification/i;
const BAD_CREDENTIALS_PATTERN =
  /AADSTS\d{4,6}|your account or password is incorrect|that password is incorrect|account (?:has been|is) locked|password has expired|enter a valid (?:email|username)/i;

/** Text of a Playwright result that shows the sign-in needs a person or the credentials were refused. */
export function detectAuthProblem(text: string): { kind: 'mfa' | 'credentials'; evidence: string } | undefined {
  const mfa = MFA_PATTERN.exec(text);
  if (mfa) return { kind: 'mfa', evidence: mfa[0] };
  const bad = BAD_CREDENTIALS_PATTERN.exec(text);
  if (bad) return { kind: 'credentials', evidence: bad[0] };
  return undefined;
}

const NOT_FOUND_PATTERN =
  /\b404\b|page not found|could not be found|can[’']t be reached|net::ERR_[A-Z_]+|ERR_NAME_NOT_RESOLVED|HTTP ERROR \d{3}|requested (?:page|url|menu item|resource) .{0,60}(?:does not exist|not found)/i;

/** Whether the result of a browser_navigate shows the target does not exist (or cannot be opened). */
export function detectUnreachable(text: string, isError: boolean): boolean {
  if (isError) return true;
  return NOT_FOUND_PATTERN.test(text.slice(0, 2500));
}

/** The same address with the parts that do not change what page it is (hash, trailing slash, case of the host) removed. */
export function normalizeTarget(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url.trim();
  }
}

const DESTRUCTIVE_LABEL = /\b(delete|remove|purge|void|wipe|truncate|erase|discard)\b/i;

/** Returns why a click is refused because it would destroy data, or undefined when it is not destructive. */
export function destructiveClick(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool !== 'browser_click') return undefined;
  // A target can be a locator such as getByTestId('SystemDefinedDeleteButton'): split camel case so control names are checked too.
  const target = typeof args.target === 'string' ? args.target.replace(/([a-z])([A-Z])/g, '$1 $2') : '';
  const label = [args.element, args.text, args.name, target].filter((v): v is string => typeof v === 'string' && v !== '').join(' ');
  const hit = DESTRUCTIVE_LABEL.exec(label);
  return hit ? `clicking "${label.slice(0, 80)}" looks destructive ("${hit[0]}")` : undefined;
}

export class AttemptGuard {
  private readonly startedAt: number;
  private readonly failedTargets = new Map<string, string>();
  private tokens = 0;
  private consecutiveErrors = 0;

  constructor(
    private readonly cfg: GuardConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  get allowDestructive(): boolean {
    return this.cfg.AGENT_ALLOW_DESTRUCTIVE === true;
  }

  /** Message for a call to a target that already failed to open, so it is not tried again. */
  previouslyFailed(url: string): string | undefined {
    const first = this.failedTargets.get(normalizeTarget(url));
    return first === undefined ? undefined : `${first} It was already tried and failed in this run, so it will not be tried again`;
  }

  /** Records a target that could not be opened. Returns a stop once too many distinct targets are missing. */
  recordUnreachable(url: string, detail: string): RunStop | undefined {
    this.failedTargets.set(normalizeTarget(url), `${url} could not be opened (${detail}).`);
    const limit = this.cfg.AGENT_MAX_UNREACHABLE_TARGETS ?? DEFAULT_MAX_UNREACHABLE_TARGETS;
    if (limit > 0 && this.failedTargets.size >= limit) {
      return {
        reason: 'unreachable',
        retryable: false,
        message: `Agent stopped: ${this.failedTargets.size} different pages could not be found or opened (e.g. ${url}). The test case points at something that does not exist in this environment, so retrying will not help.`,
      };
    }
    return undefined;
  }

  get unreachableCount(): number {
    return this.failedTargets.size;
  }

  recordUsage(usage?: { inputTokens?: number; outputTokens?: number }): void {
    this.tokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  }

  /** Tracks consecutive failing tool calls; any success resets the count. */
  recordToolResult(errored: boolean): RunStop | undefined {
    this.consecutiveErrors = errored ? this.consecutiveErrors + 1 : 0;
    const limit = this.cfg.AGENT_MAX_CONSECUTIVE_ERRORS ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
    if (limit > 0 && this.consecutiveErrors >= limit) {
      return {
        reason: 'errors',
        retryable: true,
        message: `Agent stopped: ${this.consecutiveErrors} tool calls in a row failed (limit ${limit}, AGENT_MAX_CONSECUTIVE_ERRORS). The run is not making progress.`,
      };
    }
    return undefined;
  }

  authStop(problem: { kind: 'mfa' | 'credentials'; evidence: string }): RunStop | undefined {
    if (this.cfg.AGENT_STOP_ON_AUTH_FAILURE === false) return undefined;
    return {
      reason: 'auth',
      retryable: false,
      message:
        problem.kind === 'mfa'
          ? `Agent stopped: sign-in asked for multi-factor verification ("${problem.evidence}"). The agent cannot complete it. Sign in once with \`session-login\` and set D365_STORAGE_STATE, or use an account without MFA.`
          : `Agent stopped: sign-in was refused ("${problem.evidence}"). Check D365_USERNAME and D365_PASSWORD; retrying with the same credentials can lock the account.`,
    };
  }

  /** Checked before each model call: the time and token budgets for one attempt. */
  checkBudgets(): RunStop | undefined {
    const timeout = this.cfg.AGENT_TEST_TIMEOUT_MS ?? DEFAULT_TEST_TIMEOUT_MS;
    const elapsed = this.now() - this.startedAt;
    if (timeout > 0 && elapsed >= timeout) {
      return {
        reason: 'timeout',
        retryable: true,
        message: `Agent stopped: the test ran for ${Math.round(elapsed / 1000)}s, over its ${Math.round(timeout / 1000)}s limit (AGENT_TEST_TIMEOUT_MS).`,
      };
    }
    const budget = this.cfg.AGENT_MAX_TOKENS_PER_TEST ?? DEFAULT_MAX_TOKENS_PER_TEST;
    if (budget > 0 && this.tokens >= budget) {
      return {
        reason: 'budget',
        retryable: false,
        message: `Agent stopped: the test used ${this.tokens} tokens, over its budget of ${budget} (AGENT_MAX_TOKENS_PER_TEST).`,
      };
    }
    return undefined;
  }
}
