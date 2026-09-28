# LLM Providers

The agent selects its LLM provider via `LLM_PROVIDER`. All providers implement the same tool-use protocol internally, so behavior is consistent across models.

## Anthropic Claude (default)

```env
LLM_PROVIDER=anthropic
LLM_MODEL=claude-opus-4-5-20251101
ANTHROPIC_API_KEY=sk-ant-...
```

Uses the official `@anthropic-ai/sdk` and its native tool-use format.

## OpenAI

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
```

## Azure OpenAI

```env
LLM_PROVIDER=azure-openai
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT=gpt-4o
AZURE_OPENAI_API_VERSION=2024-10-21
```

## GitHub Models / Copilot

Uses the GitHub Models Azure inference endpoint. Requires a `GITHUB_TOKEN` with `models:read` access.

```env
LLM_PROVIDER=github-models
GITHUB_TOKEN=ghp_...
GITHUB_MODELS_MODEL=gpt-4o
```

## Adding a new provider

Implement the `LlmProvider` interface in [`src/llm/types.ts`](../src/llm/types.ts) and wire it into `createLlmProvider` in [`src/llm/index.ts`](../src/llm/index.ts). Keep tool-use projection in the adapter itself so the agent core stays provider-agnostic.
