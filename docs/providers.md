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

## GitHub Copilot

Runs the agent on your **GitHub Copilot subscription** instead of a paid API key. This is a different service from GitHub Models (below): it authenticates as your Copilot account and uses the models your plan includes.

```bash
# One-time sign-in (GitHub device flow): prints a code to enter in the browser,
# checks the account can use Copilot, then saves the token to
# ~/.d365fo-agent/github-copilot.json (mode 0600).
node dist/cli/index.js copilot-login
```

```env
LLM_PROVIDER=github-copilot
GITHUB_COPILOT_MODEL=gpt-4.1   # any model your Copilot plan offers
# GITHUB_COPILOT_TOKEN=gho_...  # optional: use instead of the saved login (e.g. CI)
```

- **Model choice.** Available models depend on your plan and change over time. If a model is rejected, pick another with `GITHUB_COPILOT_MODEL`. Models must support tool calling.
- **CI.** Run `copilot-login` locally, then store the `oauth_token` value from `~/.d365fo-agent/github-copilot.json` as a repository secret named `COPILOT_OAUTH_TOKEN` (Actions secret names cannot start with `GITHUB_`; the workflow maps it to `GITHUB_COPILOT_TOKEN`) and set the `LLM_PROVIDER` repository variable to `github-copilot`. The workflow's built-in `GITHUB_TOKEN` cannot be used. To change the model, add `GITHUB_COPILOT_MODEL` to the workflow's `env`. Treat the token as a password.
- **Usage limits.** Every agent step is one request, and a run can issue up to `AGENT_MAX_STEPS` requests per attempt (times retries). Check your plan's rate limits and per-model usage multipliers before large suites.
- **Stability caveat.** GitHub does not publish a public inference API for Copilot. This provider follows the same sign-in and token exchange as the editor plugins, which is undocumented and can change without notice. Personal access tokens are not accepted. Confirm your organization's Copilot policy allows this kind of use.

## GitHub Models

The separate GitHub Models prototyping API (Azure inference endpoint). Requires a `GITHUB_TOKEN` with `models:read` access; it is **not** billed through Copilot.

```env
LLM_PROVIDER=github-models
GITHUB_TOKEN=ghp_...
GITHUB_MODELS_MODEL=gpt-4o
```

## Adding a new provider

Implement the `LlmProvider` interface in [`src/llm/types.ts`](../src/llm/types.ts) and wire it into `createLlmProvider` in [`src/llm/index.ts`](../src/llm/index.ts). Keep tool-use projection in the adapter itself so the agent core stays provider-agnostic.
