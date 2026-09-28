import type { AppConfig } from '../config/index.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import type { LlmProvider } from './types.js';

/**
 * Instantiates the LLM provider selected by config. Fails fast when required
 * credentials are missing so users don't discover it mid-run.
 */
export function createLlmProvider(cfg: AppConfig): LlmProvider {
  switch (cfg.LLM_PROVIDER) {
    case 'anthropic': {
      if (!cfg.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');
      return new AnthropicProvider({
        apiKey: cfg.ANTHROPIC_API_KEY,
        model: cfg.LLM_MODEL,
        maxTokens: cfg.LLM_MAX_TOKENS,
        temperature: cfg.LLM_TEMPERATURE,
      });
    }
    case 'openai': {
      if (!cfg.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
      return new OpenAiCompatibleProvider({
        name: 'openai',
        baseUrl: 'https://api.openai.com/v1/chat/completions',
        apiKey: cfg.OPENAI_API_KEY,
        model: cfg.OPENAI_MODEL,
        maxTokens: cfg.LLM_MAX_TOKENS,
        temperature: cfg.LLM_TEMPERATURE,
      });
    }
    case 'azure-openai': {
      if (!cfg.AZURE_OPENAI_ENDPOINT || !cfg.AZURE_OPENAI_API_KEY || !cfg.AZURE_OPENAI_DEPLOYMENT) {
        throw new Error('Azure OpenAI endpoint, key, and deployment are required');
      }
      const base = cfg.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '');
      const url = `${base}/openai/deployments/${cfg.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${cfg.AZURE_OPENAI_API_VERSION}`;
      return new OpenAiCompatibleProvider({
        name: 'azure-openai',
        baseUrl: url,
        apiKey: cfg.AZURE_OPENAI_API_KEY,
        model: cfg.AZURE_OPENAI_DEPLOYMENT,
        maxTokens: cfg.LLM_MAX_TOKENS,
        temperature: cfg.LLM_TEMPERATURE,
        authScheme: 'header',
        authHeaderName: 'api-key',
      });
    }
    case 'github-models': {
      if (!cfg.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required');
      return new OpenAiCompatibleProvider({
        name: 'github-models',
        baseUrl: 'https://models.inference.ai.azure.com/chat/completions',
        apiKey: cfg.GITHUB_TOKEN,
        model: cfg.GITHUB_MODELS_MODEL,
        maxTokens: cfg.LLM_MAX_TOKENS,
        temperature: cfg.LLM_TEMPERATURE,
      });
    }
  }
}

export type { LlmProvider } from './types.js';
