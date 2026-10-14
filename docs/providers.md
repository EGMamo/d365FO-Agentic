# LLM Providers

The agent selects its LLM provider via `LLM_PROVIDER`. All providers implement the same tool-use protocol internally, so behavior is consistent across models.

## Anthropic Claude (default)

```env
LLM_PROVIDER=anthropic
LLM_MODEL=claude-opus-4-5-20251101
ANTHROPIC_API_KEY=sk-ant-...
```

### Custom Claude API URL

To send requests to a Claude-compatible endpoint other than `api.anthropic.com` (a company gateway, a proxy, or a model router), set its address:

```env
LLM_PROVIDER=anthropic
ANTHROPIC_BASE_URL=https://llm-gateway.example.com/anthropic
ANTHROPIC_API_KEY=...          # sent as x-api-key
# ANTHROPIC_AUTH_TOKEN=...     # or: sent as Authorization: Bearer, for gateways that expect a token
LLM_MODEL=claude-opus-4-5-20251101   # the model name your endpoint expects
```

- Give the base address. The agent calls `<base>/v1/messages`, so a pasted `/v1` or `/v1/messages` ending is removed.
- Set `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or both, depending on what the endpoint checks.
- The endpoint must speak the Anthropic Messages API with tool use. For an OpenAI-style endpoint use `LLM_PROVIDER=openai-compatible` instead.
- `doctor` (or **Check setup** in the settings app) asks the endpoint for its model list (`<base>/v1/models`) and reports whether it is reachable, whether the credentials were accepted, and whether `LLM_MODEL` is in the list. A gateway without a model list still passes. A plain `http` address that is not on this computer gets a warning.
- Everything the agent sends to the model, including page content from F&O, goes to this address. Use `https` and an endpoint you trust.

In the settings app the field is **Claude API URL** on an Anthropic setup in the **AI models** tab.

Uses the official `@anthropic-ai/sdk` and its native tool-use format. Prompt caching is on by default (`LLM_PROMPT_CACHE=false` disables it): the system prompt with the tool schemas, and the conversation so far, are cached between turns. With `AGENT_VERBOSE=true` each turn logs `cached=<tokens>` when the cache hits; prompts below the model's minimum cacheable size are simply not cached.

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

## Local or any OpenAI-compatible model

Runs the agent against a model on your own machine (Ollama, LM Studio, llama.cpp, vLLM) or any hosted OpenAI-style chat endpoint. Page content then never leaves the machine, which is useful for F&O data. Nothing needs an API key locally.

```
LLM_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_MODEL=qwen3:14b            # the name shown by `ollama list`
# OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1   # default (Ollama)
# OPENAI_COMPATIBLE_API_KEY=                 # only for hosted endpoints
LLM_MAX_TOKENS=8192
```

| Server | `OPENAI_COMPATIBLE_BASE_URL` |
| --- | --- |
| Ollama (default) | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp `llama-server` | `http://localhost:8080/v1` |

`doctor` checks that the server answers and lists the model. What decides whether it works:

- **Tool calling.** The model must support it (`ollama show <model>` lists `tools` under capabilities). The agent drives the browser purely through tool calls.
- **Context window of at least 32k tokens.** F&O page snapshots are large. Ollama's `/v1` endpoint cannot set the window per request, so set it on the server (`OLLAMA_CONTEXT_LENGTH=32768`, or the slider in the Ollama app), then check `ollama ps`. Too small truncates the prompt silently; **too large is just as bad**: a 262144-token window pushed a 27B model to 31 GB on a 24 GB Mac, split between CPU and GPU, roughly 10x slower. You want `100% GPU` in `ollama ps`.
- **Thinking models** spend output tokens on reasoning before they call a tool. Use `LLM_MAX_TOKENS=8192` or more, or the reply can be cut off before the tool call.
- **Small windows:** set `AGENT_CONTEXT_KEEP_RECENT=1` so only the latest page snapshot stays in the prompt.
- **Model size.** Multi-step browsing is hard for small models; expect to want roughly 14B+ parameters. A 27B (IQ3) model on an M4 Pro (24 GB) completed a login smoke test at about 20 s per turn with a 32k window.
- **Timeouts.** For a server on this machine (`localhost`, `127.0.0.1`, `[::1]` or `0.0.0.0`) the request timeout is at least 5 minutes (`LLM_HTTP_TIMEOUT_MS` can only raise it), since a cold model load plus a long prompt can be slow.

The guardrails (tool allowlist, navigation limits, production block) apply to every model. Weaker models are easier to steer with injected page text, so they matter more here, not less.

## Adding a new provider

Implement the `LlmProvider` interface in [`src/llm/types.ts`](../src/llm/types.ts) and wire it into `createLlmProvider` in [`src/llm/index.ts`](../src/llm/index.ts). Keep tool-use projection in the adapter itself so the agent core stays provider-agnostic.
