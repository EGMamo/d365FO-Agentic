import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { resolveGitHubToken } from '../llm/github-copilot.js';

/**
 * Central configuration loaded from environment variables. All secrets and
 * endpoints live in `.env` so the agent stays portable.
 */
const providerEnum = z.enum(['anthropic', 'openai', 'azure-openai', 'github-models', 'github-copilot']);
const stepStatusEnum = z.enum(['passed', 'failed', 'skipped', 'blocked']);

const envSchema = z.object({
  LLM_PROVIDER: providerEnum.default('anthropic'),
  LLM_MODEL: z.string().default('claude-opus-4-5-20251101'),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.1),

  ANTHROPIC_API_KEY: z.string().optional(),
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
  D365_TENANT_ID: z.string().optional(),
  D365_USERNAME: z.string().optional(),
  D365_PASSWORD: z.string().optional(),
  D365_COMPANY: z.string().default('USMF'),
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

  LEARN_MCP_URL: z.string().default('https://learn.microsoft.com/api/mcp'),

  AGENT_DRY_RUN: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  AGENT_VERBOSE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(40),
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
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
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
      if (!cfg.ANTHROPIC_API_KEY) issues.push('ANTHROPIC_API_KEY is required for provider=anthropic');
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
  }

  if (!cfg.D365_BASE_URL) issues.push('D365_BASE_URL is required to run tests');
  const hasPassword = !!cfg.D365_USERNAME && !!cfg.D365_PASSWORD;
  if (!hasPassword) {
    if (!cfg.D365_STORAGE_STATE) {
      issues.push('D365_USERNAME and D365_PASSWORD are required so the agent can sign in to F&O (or use a saved session: D365_STORAGE_STATE)');
    } else if (!existsSync(resolve(cfg.D365_STORAGE_STATE))) {
      issues.push(`D365_STORAGE_STATE points at ${cfg.D365_STORAGE_STATE}, which does not exist. Run \`d365fo-agent session-login\` or set D365_USERNAME and D365_PASSWORD`);
    }
  }
  return issues;
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
  }
}
