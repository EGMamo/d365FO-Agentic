# d365FO-Agentic

Portable AI agent for end-to-end regression and unit testing of Microsoft **Dynamics 365 Finance & Operations**. It drives the F&O web client through the [Playwright MCP server](https://github.com/microsoft/playwright-mcp), grounds itself on official Microsoft documentation via the [Microsoft Learn MCP server](https://learn.microsoft.com/en-us/training/support/mcp), and reads test cases from **Azure DevOps** (Test Plans / Test Suites) — publishing results back to a Test Run with attachments.

The agent is **LLM-agnostic** and ships with adapters for:
- **Anthropic Claude** (default)
- **OpenAI**
- **Azure OpenAI**
- **GitHub Copilot** (uses your Copilot subscription — see [Providers](docs/providers.md#github-copilot))
- **GitHub Models**
- **Local or any OpenAI-compatible model** — Ollama, LM Studio, llama.cpp, vLLM (see [Providers](docs/providers.md#local-or-any-openai-compatible-model))

It maintains a **local knowledge base** so it can learn selectors, recipes, and remediations across runs.

> **MVP status.** This repository is an MVP scaffold: it wires the LLM ↔ MCP ↔ Azure DevOps ↔ D365 F&O loop with an extensible tool-use protocol. Battle-hardening for specific F&O modules is expected to grow through the knowledge base and iterative use.

## Features

- Plan → act → report loop with pluggable LLM providers.
- MCP client for stdio (Playwright) and HTTP streamable (Learn) servers.
- Azure DevOps ingestion of test cases + publishing of test runs, results, and attachments (PAT via `.env`).
- Deterministic, structured reports: HTML, JSON, JUnit XML.
- Controlled reloop/retry of failed or blocked test cases with attempt audit history.
- Self-learning knowledge base (`knowledge/kb.json`) with keyword retrieval.
- Dry-run mode that plans without mutating the target environment.
- CLI: `doctor`, `copilot-login`, `discover`, `run`, `report`, `upload`, `learn`.
- GitHub Actions workflow for scheduled or on-demand runs.

## Desktop icon and settings app

No terminal needed after a one-time setup:

```bash
npm install
npm run launcher:install   # builds, then puts a "D365FO Agent" icon on your desktop
```

Double-click the icon: it starts a small local web app and opens it in your browser (macOS `.command`, Windows `.lnk`, Linux `.desktop`). Close the window it opens to stop. `npm run ui` does the same from a terminal; `npm run launcher:remove` removes the icon.

In the app you can create, edit, duplicate and delete **named profiles** (one per environment, for example "Sandbox UAT" and "Dev"), choose the one in use, and press **Check setup** to run `doctor` against it. Secrets are masked in the browser. Profiles are stored in your user config folder, outside the project, with owner-only permissions (macOS `~/Library/Application Support/d365fo-agent`, Windows `%APPDATA%\d365fo-agent`, Linux `~/.config/d365fo-agent`; override with `D365FO_AGENT_HOME`). The server listens on `127.0.0.1` only and requires a per-machine token.

The profile in use replaces `.env` for every command. Pick another per command with `--profile "Name"` or `D365FO_PROFILE=Name` (`D365FO_PROFILE=none` forces `.env`).

## Quick start

```bash
# 1. Install
npm install
npm run build

# 2. Configure
cp .env.example .env
# fill in ANTHROPIC_API_KEY, D365_BASE_URL, and (optionally) Azure DevOps + F&O creds
# To use GitHub Copilot instead of Claude: set LLM_PROVIDER=github-copilot, then run
#   node dist/cli/index.js copilot-login

# 3. Sanity check
node dist/cli/index.js doctor

# 4. Run against the local example test cases (dry-run first!)
node dist/cli/index.js run --local examples/testcases --dry-run

# 5. Real run + upload to Azure DevOps
node dist/cli/index.js run --plan 1234 --suite 5678 --upload

# 6. Run with retries (reloop)
node dist/cli/index.js run --local examples/testcases --reloop-max-retries 2 --reloop-retry-on failed,blocked
```

Reports are written to `./reports` and the knowledge base to `./knowledge/kb.json`.

The first `run` downloads the Playwright browser it needs (~300 MB, once); later runs only spend about a second checking it. Set `PW_AUTO_INSTALL=false` to skip this and install it yourself with `npx @playwright/mcp install-browser chrome-for-testing`.

## Configuration

All configuration is via environment variables (loaded from `.env`). See [`.env.example`](.env.example) for the full list. The essentials:

| Variable | Purpose |
| --- | --- |
| `LLM_PROVIDER` | `anthropic` (default), `openai`, `azure-openai`, `github-models`, `github-copilot`, `openai-compatible` (local models) |
| `ANTHROPIC_API_KEY` | Required when provider is `anthropic` |
| `OPENAI_COMPATIBLE_MODEL` / `OPENAI_COMPATIBLE_BASE_URL` | Provider `openai-compatible`: model name and server URL (default Ollama, `http://localhost:11434/v1`) |
| `GITHUB_COPILOT_TOKEN` / `GITHUB_COPILOT_MODEL` | Provider `github-copilot`: token (or run `copilot-login` to save one) and model |
| `D365_BASE_URL` | Your F&O sandbox URL |
| `D365_USERNAME` / `D365_PASSWORD` | Test account credentials (non-MFA recommended for automated runs) |
| `D365_ENVIRONMENT_TYPE` | Declare `sandbox` / `production` / `dev`; empty guesses from the URL (see [Grounding & safety](#grounding--safety)) |
| `D365_STORAGE_STATE` | Optional saved browser session (see [docs/d365fo.md](docs/d365fo.md#signing-in-with-a-saved-session-optional)); replaces the password when set |
| `AZDO_ORG_URL` / `AZDO_PROJECT` / `AZDO_PAT` | Azure DevOps ingestion + reporting |
| `AZDO_TEST_PLAN_ID` / `AZDO_TEST_SUITE_ID` | Default plan/suite to discover from |
| `PW_BROWSER` / `PW_AUTO_INSTALL` | Playwright browser (`chromium` default) and whether to download it automatically when missing (default `true`) |
| `AGENT_ALLOW_PRODUCTION` / `AGENT_ALLOWED_HOSTS` / `AGENT_ALLOWED_TOOLS_EXTRA` | Guardrail overrides (production runs, extra navigable hosts, extra MCP tools) |
| `AGENT_CONTEXT_KEEP_RECENT` / `LLM_PROMPT_CACHE` | Prompt size and cost: how many recent page snapshots stay verbatim, and Anthropic prompt caching |
| `AGENT_TOOL_TIMEOUT_MS` / `AGENT_NAV_TIMEOUT_MS` | Time budget per tool call (default 60 s, navigation 90 s); a call over budget is reported and recorded as a timeout |
| `PW_TRACE` | `on-failure` (default), `on` or `off`: save a Playwright trace per attempt; kept only for failed attempts with `on-failure` |
| `RELEASE_PLANNER_MCP_URL` | Optional: a running FastTrack Release Planner MCP server (read-only release-wave queries) |
| `AGENT_RELOOP_MAX_RETRIES` / `AGENT_RELOOP_RETRY_ON` | Retry controls for failed/blocked outcomes |
| `LLM_HTTP_TIMEOUT_MS` / `LLM_HTTP_MAX_RETRIES` | LLM timeout and retry resilience |
| `AZDO_HTTP_TIMEOUT_MS` / `AZDO_HTTP_MAX_RETRIES` | Azure DevOps timeout and retry resilience |

## Test-case format

Local test cases are JSON files following [`src/testing/types.ts`](src/testing/types.ts). Two examples live in [`examples/testcases`](examples/testcases). Azure DevOps test cases are read from the configured plan/suite; steps are extracted from `Microsoft.VSTS.TCM.Steps`.

## Grounding & safety

The agent is prompted as a **QA persona** that cites Microsoft Learn for product-behaviour claims and treats page, tool and knowledge-base content as untrusted data. The prompt is not the control, though. These guardrails are enforced in code:

- **Production block.** `run` refuses an environment that is, or looks like, production. Only LCS-managed sandboxes (`<name>.sandbox.operations…`) are recognised from the host; Power Platform (unified) environments use the same host format for sandbox and production, so declare them with `D365_ENVIRONMENT_TYPE=sandbox`. `AGENT_ALLOW_PRODUCTION=true` is the explicit override.
- **Tool allowlist.** Only a safe subset of the Playwright and Learn MCP tools is shown to the model, and calls to anything else are refused at dispatch. That keeps cookie/storage dumps, arbitrary JS, file access and network internals out of reach of a prompt-injected page. Opt tools in with `AGENT_ALLOWED_TOOLS_EXTRA`.
- **Navigation and legal entity.** Model-requested navigation is limited to the F&O host and Microsoft sign-in (extend with `AGENT_ALLOWED_HOSTS`), and `cmp=` company links must match the test's legal entity (`legalEntity` in the test case, else `D365_COMPANY`). Redirects the browser follows on its own are not intercepted.
- **Scrubbed, bounded results.** Configured secrets and token-shaped strings are redacted, and sizes capped, before model-written text reaches reports, the knowledge base or Azure DevOps. Invalid tool arguments are rejected instead of recorded.
- **Audit trail.** Every refused call is listed under `policyBlocks` in `results.json` and in the HTML report; an attempt that keeps probing the guardrails is stopped.
- **Run limits per attempt.** A page, menu item or path that cannot be opened is never retried (navigating to it again is refused), the step is reported blocked and the run moves on, and the test is not re-run by the reloop; after `AGENT_MAX_UNREACHABLE_TARGETS` (3) different missing pages it stops. MFA prompts and refused sign-ins stop the test at once (`AGENT_STOP_ON_AUTH_FAILURE`). Also bounded: wall-clock time (`AGENT_TEST_TIMEOUT_MS`), tokens (`AGENT_MAX_TOKENS_PER_TEST`), failing tool calls in a row (`AGENT_MAX_CONSECUTIVE_ERRORS`), identical calls in a row (`AGENT_MAX_REPEATED_CALLS`) and model turns (`AGENT_MAX_STEPS`). `0` turns a limit off.
- **No destructive clicks.** Clicks on controls labelled delete, remove, purge, void and the like are refused unless `AGENT_ALLOW_DESTRUCTIVE=true`.
- **Dry-run** (`AGENT_DRY_RUN=true` / `--dry-run`) skips state-changing browser tools.

Redaction cannot recognise arbitrary business data (customer names, amounts) that a page shows, so treat `reports/` and `knowledge/` as sensitive.

## Documentation

- [Providers](docs/providers.md)
- [Azure DevOps setup](docs/azure-devops.md)
- [D365 F&O notes](docs/d365fo.md)
- [Self-learning](docs/self-learning.md)
- [Roadmap](docs/roadmap.md)
- [Sandbox verification checklist](docs/sandbox-checklist.md)
- [RSAT and Test Plans note](docs/rsat-and-test-plans.md)
- [Test data setup note](docs/test-data-setup.md)
- [Desktop transition roadmap](docs/desktop-roadmap.md)

## License

MIT — see [LICENSE](LICENSE).
