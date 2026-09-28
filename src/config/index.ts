import 'dotenv/config';
import { z } from 'zod';

/**
 * Central configuration loaded from environment variables. All secrets and
 * endpoints live in `.env` so the agent stays portable.
 */
const providerEnum = z.enum(['anthropic', 'openai', 'azure-openai', 'github-models']);

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

  PW_HEADLESS: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  PW_TRACE: z.enum(['on', 'off', 'on-failure']).default('on-failure'),
  PW_VIDEO: z.enum(['on', 'off', 'on-failure']).default('off'),
  PW_BROWSER: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),

  LEARN_MCP_URL: z.string().default('https://learn.microsoft.com/api/mcp'),

  AGENT_DRY_RUN: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(40),
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
  }

  if (!cfg.D365_BASE_URL) issues.push('D365_BASE_URL is required to run tests');
  return issues;
}
