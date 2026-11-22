import './load-env.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_MODEL } from '../profiles/ai.js';
import { productionIssue } from '../d365fo/environment.js';

/**
 * Central configuration loaded from environment variables. All secrets and
 * endpoints live in `.env` so the agent stays portable.
 */
const providerEnum = z.literal('anthropic');
const csvList = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  LLM_PROVIDER: providerEnum.default('anthropic'),
  LLM_MODEL: z.preprocess((v) => typeof v === 'string' ? v.trim() || undefined : v, z.string().default(DEFAULT_MODEL)),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.1),
  // Anthropic only: cache the system prompt, tool schemas and conversation prefix between turns.
  LLM_PROMPT_CACHE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),

  // Wire protocol of the model endpoint: Claude's Messages API, or OpenAI-compatible chat completions for gateways
  // (LiteLLM, corporate GenAI services) that only serve /v1/chat/completions. Same key, URL and model settings.
  LLM_API_FORMAT: z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() || undefined : v), z.enum(['anthropic', 'openai']).default('anthropic')),
  ANTHROPIC_API_KEY: z.string().optional(),
  // A Claude-compatible endpoint other than api.anthropic.com: a company gateway, a proxy, or a model router.
  ANTHROPIC_BASE_URL: z
    .string()
    .transform((v) => v.trim() || undefined)
    .optional(),
  // Sent as `Authorization: Bearer` for gateways that expect a token in place of an Anthropic API key.
  ANTHROPIC_AUTH_TOKEN: z
    .string()
    .transform((v) => v.trim() || undefined)
    .optional(),
  AZDO_ORG_URL: z.string().optional(),
  AZDO_PROJECT: z.string().optional(),
  AZDO_PAT: z.string().optional(),
  // How to sign in to Azure DevOps: `pat` (AZDO_PAT) or `azure-cli` (the Microsoft account of `az login`).
  // Unset: the token when one is set, otherwise the Azure CLI sign-in.
  AZDO_AUTH: z
    .enum(['', 'pat', 'azure-cli'])
    .transform((v) => v || undefined)
    .optional(),
  // Optional: the Entra tenant to get the Azure DevOps token for, when the account is in several.
  AZDO_TENANT_ID: z.string().transform((v) => v.trim() || undefined).optional(),
  AZDO_TEST_PLAN_ID: z.string().optional(),
  AZDO_TEST_SUITE_ID: z.string().optional(),
  D365_BASE_URL: z.string().optional(),
  D365_USERNAME: z.string().optional(),
  D365_PASSWORD: z.string().optional(),
  D365_COMPANY: z.string().default('USMF'),
  // Declare what the environment is; otherwise it is guessed from the host (see d365fo/environment.ts).
  D365_ENVIRONMENT_TYPE: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toLowerCase() || undefined : v),
    z.enum(['sandbox', 'production', 'dev']).optional(),
  ),
  // Optional: sign in with a saved browser session instead of a password. Created by `session-login`.
  D365_STORAGE_STATE: z
    .string()
    .transform((v) => v.trim() || undefined)
    .optional(),
  D365_SESSION_MAX_AGE_HOURS: z.coerce.number().positive().default(12),
  // How the agent signs in to F&O's OData data endpoint. It needs a Microsoft access token: a browser session is not accepted there.
  // browser: your own sign-in in a browser window, once (`d365-data-login`), kept for later runs. password: D365_USERNAME and
  // D365_PASSWORD (an account without MFA). azure-cli: the account of `az login`. Unset: follows how the tests sign in.
  D365_ODATA_AUTH: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toLowerCase() || undefined : v),
    z.enum(['browser', 'password', 'azure-cli']).optional(),
  ),
  // Lets the agent read F&O data through OData (read only) to check prerequisites and records.
  AGENT_ODATA: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),

  PW_HEADLESS: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  PW_TRACE: z.enum(['on', 'off', 'on-failure']).default('on-failure'),
  PW_VIDEO: z.enum(['on', 'off', 'on-failure']).default('off'),
  PW_BROWSER: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  PW_AUTO_INSTALL: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  // How long Playwright waits for an element before an action fails. F&O forms are slow to render; Playwright's default is 5 s.
  PW_ACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  LEARN_MCP_URL: z.string().default('https://learn.microsoft.com/api/mcp'),
  AGENT_DRY_RUN: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  // Save standalone Playwright specs from successful allowlisted MCP calls. Replay itself never uses a model or MCP.
  AGENT_RECORD_TESTS: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  // Defaults to <REPORT_DIR>/replay, keeping each profile's generated project and results separate.
  AGENT_REPLAY_DIR: z.string().transform((v) => v.trim() || undefined).optional(),
  AGENT_VERBOSE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(40),
  // Per-tool-call time budgets. A call that exceeds them is reported to the model and recorded on the result.
  AGENT_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  AGENT_NAV_TIMEOUT_MS: z.coerce.number().int().positive().default(90000),
  AGENT_MAX_REPEATED_CALLS: z.coerce.number().int().min(0).default(3),
  // Run limits per attempt (0 disables a limit): wall-clock time, tokens, failing tool calls in a row,
  // and how many different pages may be missing before the test is stopped.
  AGENT_TEST_TIMEOUT_MS: z.coerce.number().int().min(0).default(900000),
  AGENT_MAX_TOKENS_PER_TEST: z.coerce.number().int().min(0).default(1000000),
  AGENT_MAX_CONSECUTIVE_ERRORS: z.coerce.number().int().min(0).default(5),
  AGENT_MAX_UNREACHABLE_TARGETS: z.coerce.number().int().min(0).default(3),
  // Stop at once when sign-in needs MFA or the credentials are refused (retrying can lock the account).
  AGENT_STOP_ON_AUTH_FAILURE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  // Clicks on controls labelled delete/remove/purge/void are refused unless this is true.
  AGENT_ALLOW_DESTRUCTIVE: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  // F&O speed-ups: wait for the "Please wait" overlay after each action, drop anonymous wrapper nodes from page
  // snapshots, and learn the locator of every control used per form (<KB_DIR>/pages.json) to reuse it later.
  AGENT_FNO_AUTO_WAIT: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  AGENT_SLIM_SNAPSHOTS: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  AGENT_LEARN_PAGES: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  // Keep the latest N bulky tool results (page snapshots) verbatim and collapse older ones (0 disables).
  AGENT_CONTEXT_KEEP_RECENT: z.coerce.number().int().min(0).default(3),
  // Before a case runs, look for unresolved placeholders (TBC, TBD, {{...}}) that stand for existing data or setup.
  // block: end such a case blocked at once, without opening the browser. partial: run only the other steps. off: no check.
  AGENT_PREFLIGHT: z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() || undefined : v), z.enum(['block', 'partial', 'off']).default('block')),
  // A case that needs a specific user role (or "act as" another user): true runs it as the signed-in user instead of blocking it.
  AGENT_IGNORE_USER_ROLE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  // Unset values that are existing F&O data (an active vendor, an item, a warehouse): true lets the agent find one in F&O
  // (read only, needs AGENT_ODATA) and suggests saving it to the test case's parameter values after the run.
  AGENT_FILL_FROM_ERP: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  // When a case that changed data does not pass, discard the form's unsaved changes at the end so no half-made record is saved.
  AGENT_DISCARD_UNSAVED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  // Guardrails. The environment check and tool/navigation policy are enforced in code, not just in the prompt.
  AGENT_ALLOW_PRODUCTION: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  AGENT_ALLOWED_HOSTS: csvList.transform((v) => v.map((h) => h.toLowerCase())),
  AGENT_ALLOWED_TOOLS_EXTRA: csvList,
  AZDO_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  AZDO_HTTP_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  AZDO_HTTP_RETRY_BASE_MS: z.coerce.number().int().positive().default(800),
  KB_DIR: z.string().default('./knowledge'),
  REPORT_DIR: z.string().default('./reports'),
  /** Set by the profile store. Without an explicit REPORT_DIR, reports go to reports/<id>. */
  PROFILE_ID: z.string().regex(/^[a-z0-9]{8,32}$/).optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;

/** Parses settings from a set of variables (defaults applied). `loadConfig` does this once for `process.env`. */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const data = parsed.data;
  if (data.PROFILE_ID && !env.REPORT_DIR?.trim()) data.REPORT_DIR = `./reports/${data.PROFILE_ID}`;
  return data;
}

export function loadConfig(): AppConfig {
  cached ??= parseConfig(process.env);
  return cached;
}

/**
 * Runs a set of provider-specific checks and returns human-readable issues.
 * Used by the `doctor` CLI command and at the start of a run.
 */
export function validateForRun(cfg: AppConfig): string[] {
  const issues: string[] = [];

  switch (cfg.LLM_PROVIDER) {
    case 'anthropic':
      if (!cfg.ANTHROPIC_API_KEY && !cfg.ANTHROPIC_AUTH_TOKEN) {
        issues.push(cfg.ANTHROPIC_BASE_URL ? 'ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is required for the custom Claude API URL' : 'ANTHROPIC_API_KEY is required for provider=anthropic');
      }
      if (cfg.ANTHROPIC_BASE_URL && !isHttpUrl(cfg.ANTHROPIC_BASE_URL)) issues.push(`ANTHROPIC_BASE_URL is not a valid http(s) URL: ${cfg.ANTHROPIC_BASE_URL}`);
      if (cfg.LLM_API_FORMAT === 'openai' && !cfg.ANTHROPIC_BASE_URL) issues.push('LLM_API_FORMAT=openai needs the gateway address in ANTHROPIC_BASE_URL');
      break;
  }

  if (!cfg.D365_BASE_URL) issues.push('D365_BASE_URL is required to run tests');
  const prod = productionIssue(cfg);
  if (prod) issues.push(prod);
  const hasPassword = !!cfg.D365_USERNAME && !!cfg.D365_PASSWORD;
  if (!hasPassword) {
    if (!cfg.D365_STORAGE_STATE) {
      issues.push('Sign-in is not configured: set D365_USERNAME and D365_PASSWORD, or a saved session (D365_STORAGE_STATE).');
    } else if (!existsSync(resolve(cfg.D365_STORAGE_STATE))) {
      issues.push(`D365_STORAGE_STATE points at ${cfg.D365_STORAGE_STATE}, which does not exist. Run \`d365fo-agent session-login\` or set D365_USERNAME and D365_PASSWORD`);
    }
  }
  return issues;
}

export function activeModel(cfg: AppConfig): string { return cfg.LLM_MODEL; }

function isHttpUrl(v: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol);
  } catch {
    return false;
  }
}
