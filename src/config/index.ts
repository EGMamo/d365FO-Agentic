import './load-env.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { resolveGitHubToken } from '../llm/github-copilot.js';
import { productionIssue } from '../d365fo/environment.js';

/**
 * Central configuration loaded from environment variables. All secrets and
 * endpoints live in `.env` so the agent stays portable.
 */
const providerEnum = z.enum(['anthropic', 'openai', 'azure-openai', 'github-models', 'github-copilot', 'openai-compatible']);
const stepStatusEnum = z.enum(['passed', 'failed', 'skipped', 'blocked']);
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
  LLM_MODEL: z.string().default('claude-opus-4-5-20251101'),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.1),
  // Anthropic only: cache the system prompt, tool schemas and conversation prefix between turns.
  LLM_PROMPT_CACHE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),

  ANTHROPIC_API_KEY: z.string().optional(),
  // A Claude-compatible endpoint other than api.anthropic.com: a company gateway, a proxy, or a model router.
  ANTHROPIC_BASE_URL: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  // Sent as `Authorization: Bearer` for gateways that expect a token in place of an Anthropic API key.
  ANTHROPIC_AUTH_TOKEN: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o'),
  AZURE_OPENAI_ENDPOINT: z.string().optional(),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
  AZURE_OPENAI_API_VERSION: z.string().default('2024-10-21'),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_MODELS_MODEL: z.string().default('gpt-4o'),
  GITHUB_COPILOT_TOKEN: z.string().optional(),
  GITHUB_COPILOT_MODEL: z.string().default('gpt-4.1'),
  // Any OpenAI-compatible chat endpoint: a local Ollama / LM Studio / llama.cpp / vLLM server, or a hosted one.
  OPENAI_COMPATIBLE_BASE_URL: z.string().default('http://localhost:11434/v1'),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_MODEL: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),

  AZDO_ORG_URL: z.string().optional(),
  AZDO_PROJECT: z.string().optional(),
  AZDO_PAT: z.string().optional(),
  AZDO_TEST_PLAN_ID: z.string().optional(),
  AZDO_TEST_SUITE_ID: z.string().optional(),
  AZDO_USE_MCP: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),

  D365_BASE_URL: z.string().optional(),
  // Optional Entra app registration (client credentials) for read-only OData checks; see d365fo/entra.ts.
  D365_TENANT_ID: z.string().optional().transform((v) => v?.trim() || undefined),
  D365_CLIENT_ID: z.string().optional().transform((v) => v?.trim() || undefined),
  D365_CLIENT_SECRET: z.string().optional().transform((v) => v || undefined),
  D365_AUTHORITY_HOST: z.string().optional().transform((v) => v?.trim() || undefined),
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
    .optional()
    .transform((v) => v?.trim() || undefined),
  D365_SESSION_MAX_AGE_HOURS: z.coerce.number().positive().default(12),

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
  // Optional: URL of a running Release Planner MCP server (FastTrack sample, e.g. http://localhost:3000/mcp).
  RELEASE_PLANNER_MCP_URL: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),

  AGENT_DRY_RUN: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
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
  // Replay a case from the recorded Playwright code of its last passing run before asking the AI (<KB_DIR>/replays.json).
  // Only cases whose every expected result was checked with a recorded assertion are replayed; a failed replay falls back to the AI.
  AGENT_REPLAY: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  // Keep the latest N bulky tool results (page snapshots) verbatim and collapse older ones (0 disables).
  AGENT_CONTEXT_KEEP_RECENT: z.coerce.number().int().min(0).default(3),
  // Guardrails. The environment check and tool/navigation policy are enforced in code, not just in the prompt.
  AGENT_ALLOW_PRODUCTION: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  AGENT_ALLOWED_HOSTS: csvList.transform((v) => v.map((h) => h.toLowerCase())),
  AGENT_ALLOWED_TOOLS_EXTRA: csvList,
  AGENT_RELOOP_MAX_RETRIES: z.coerce.number().int().min(0).default(1),
  AGENT_RELOOP_RETRY_ON: z
    .string()
    .default('failed,blocked')
    .transform((v) =>
      v
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter((x): x is z.infer<typeof stepStatusEnum> => stepStatusEnum.safeParse(x).success),
    ),
  AGENT_RELOOP_COOLDOWN_MS: z.coerce.number().int().min(0).default(1000),
  LLM_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  LLM_HTTP_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  LLM_HTTP_RETRY_BASE_MS: z.coerce.number().int().positive().default(500),
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
      break;
    case 'openai':
      if (!cfg.OPENAI_API_KEY) issues.push('OPENAI_API_KEY is required for provider=openai');
      break;
    case 'azure-openai':
      if (!cfg.AZURE_OPENAI_ENDPOINT || !cfg.AZURE_OPENAI_API_KEY || !cfg.AZURE_OPENAI_DEPLOYMENT) {
        issues.push('AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT are required');
      }
      break;
    case 'github-models':
      if (!cfg.GITHUB_TOKEN) issues.push('GITHUB_TOKEN is required for provider=github-models');
      break;
    case 'github-copilot':
      if (!resolveGitHubToken(cfg.GITHUB_COPILOT_TOKEN)) {
        issues.push('No GitHub Copilot credentials: set GITHUB_COPILOT_TOKEN or run `d365fo-agent copilot-login`');
      }
      break;
    case 'openai-compatible':
      if (!cfg.OPENAI_COMPATIBLE_MODEL) issues.push('OPENAI_COMPATIBLE_MODEL is required for provider=openai-compatible (e.g. the name shown by `ollama list`)');
      if (!isHttpUrl(cfg.OPENAI_COMPATIBLE_BASE_URL)) issues.push(`OPENAI_COMPATIBLE_BASE_URL is not a valid http(s) URL: ${cfg.OPENAI_COMPATIBLE_BASE_URL}`);
      break;
  }

  if (!cfg.D365_BASE_URL) issues.push('D365_BASE_URL is required to run tests');
  const prod = productionIssue(cfg);
  if (prod) issues.push(prod);
  const hasPassword = !!cfg.D365_USERNAME && !!cfg.D365_PASSWORD;
  const hasApp = !!(cfg.D365_TENANT_ID && cfg.D365_CLIENT_ID && cfg.D365_CLIENT_SECRET);
  const appParts = [cfg.D365_TENANT_ID, cfg.D365_CLIENT_ID, cfg.D365_CLIENT_SECRET].filter(Boolean).length;
  if (appParts > 0 && !hasApp) issues.push('The Entra app registration needs all three of D365_TENANT_ID, D365_CLIENT_ID and D365_CLIENT_SECRET');
  if (!hasPassword) {
    if (!cfg.D365_STORAGE_STATE) {
      // An app registration alone is enough for data-only test cases; browser steps will report blocked.
      if (!hasApp) issues.push('Sign-in is not configured: set D365_USERNAME and D365_PASSWORD, a saved session (D365_STORAGE_STATE), or an Entra app registration (D365_TENANT_ID, D365_CLIENT_ID, D365_CLIENT_SECRET)');
    } else if (!existsSync(resolve(cfg.D365_STORAGE_STATE))) {
      issues.push(`D365_STORAGE_STATE points at ${cfg.D365_STORAGE_STATE}, which does not exist. Run \`d365fo-agent session-login\` or set D365_USERNAME and D365_PASSWORD`);
    }
  }
  return issues;
}

/**
 * A hint for the most common mix-up: LLM_MODEL only applies to the anthropic provider, every other provider
 * reads its own variable, so setting LLM_MODEL silently changes nothing.
 */
export function ignoredModelHint(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const ownVariable: Partial<Record<AppConfig['LLM_PROVIDER'], string>> = {
    openai: 'OPENAI_MODEL',
    'azure-openai': 'AZURE_OPENAI_DEPLOYMENT',
    'github-models': 'GITHUB_MODELS_MODEL',
    'github-copilot': 'GITHUB_COPILOT_MODEL',
    'openai-compatible': 'OPENAI_COMPATIBLE_MODEL',
  };
  const own = ownVariable[cfg.LLM_PROVIDER];
  if (!own || !env.LLM_MODEL?.trim() || env[own]?.trim()) return undefined;
  return `LLM_MODEL=${env.LLM_MODEL.trim()} is ignored: it only applies to provider=anthropic. Provider ${cfg.LLM_PROVIDER} uses ${own}, which is not set, so it runs ${activeModel(cfg)}.`;
}

/** The model the selected provider will actually use (each provider reads its own variable). */
export function activeModel(cfg: AppConfig): string {
  switch (cfg.LLM_PROVIDER) {
    case 'anthropic':
      return cfg.LLM_MODEL;
    case 'openai':
      return cfg.OPENAI_MODEL;
    case 'azure-openai':
      return cfg.AZURE_OPENAI_DEPLOYMENT ?? '(missing)';
    case 'github-models':
      return cfg.GITHUB_MODELS_MODEL;
    case 'github-copilot':
      return cfg.GITHUB_COPILOT_MODEL;
    case 'openai-compatible':
      return cfg.OPENAI_COMPATIBLE_MODEL ?? '(missing)';
  }
}

function isHttpUrl(v: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol);
  } catch {
    return false;
  }
}
