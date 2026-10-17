import type { AppConfig } from '../config/index.js';
import { AnthropicProvider } from './anthropic.js';
import type { LlmProvider } from './types.js';

export function createLlmProvider(cfg: AppConfig): LlmProvider {
  if (!cfg.ANTHROPIC_API_KEY && !cfg.ANTHROPIC_AUTH_TOKEN) throw new Error('Add your Claude API key in Settings.');
  return new AnthropicProvider({
    apiKey: cfg.ANTHROPIC_API_KEY, authToken: cfg.ANTHROPIC_AUTH_TOKEN,
    baseURL: cfg.ANTHROPIC_BASE_URL, model: cfg.LLM_MODEL,
    maxTokens: cfg.LLM_MAX_TOKENS, temperature: cfg.LLM_TEMPERATURE, promptCache: cfg.LLM_PROMPT_CACHE,
  });
}
export type { LlmProvider } from './types.js';
