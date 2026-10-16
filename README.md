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

## Features

- Plan → act → report loop with pluggable LLM providers.
- MCP client for stdio (Playwright) and HTTP streamable (Learn) servers.
- Azure DevOps ingestion of test cases + publishing of test runs, results, and attachments (PAT via `.env`).
- Deterministic, structured reports: HTML, JSON, JUnit XML. In JUnit a failed case is a `<failure>`, a blocked case an `<error>` (it could not be judged, so CI should not read it as a harmless skip), and a skipped or interrupted case `<skipped>`.
- Controlled reloop/retry of failed or blocked test cases with attempt audit history.
- Self-learning per-form control map (`knowledge/pages.json`), learned live during runs.
- Self-learning knowledge base (`knowledge/kb.json`): BM25 retrieval with F&O synonyms, outcome feedback, stale-path detection and pruning.
- Reflexion on retries (the agent is told what went wrong last time) and failure triage in every report: each case that did not pass gets a category (`assertion`, `sign_in`, `not_found`, `guardrail`, `timeout`, `budget`, `unverified`, `agent`, `infrastructure` or `blocked`) and a hint for what to do.
- `generate`: draft local test cases from a plain-language description, validated and grounded in the knowledge base.
- Dry-run mode that skips state-changing browser actions (clicks, typing, form fills); navigation and page snapshots still run.
- Built-in chat in the settings app: ask in plain words, no Open WebUI or Docker needed.
- **Replay without the AI.** A case that passed is recorded as Playwright code with the checks the agent made; the next run replays it in seconds with no model calls and only asks the AI when the replay fails. `export-tests` writes the recordings as Playwright tests you can run with `npx playwright test`.
- **A skill for coding agents.** [`skills/d365fo-playwright-cli`](skills/README.md) teaches Claude Code, GitHub Copilot and other coding agents to test F&O with [playwright-cli](https://github.com/microsoft/playwright-cli), using what this app has learned.
- CLI: `doctor`, `copilot-login`, `session-login`, `discover`, `run`, `report`, `upload`, `generate`, `learn`, `export-tests`, `ui`, `openwebui`, `studio`, `install-launcher`, `uninstall-launcher`.
- GitHub Actions workflow (`.github/workflows/agent-run.yml`) for on-demand runs of a local test-case folder, started by hand (`workflow_dispatch`); it keeps `reports/` and `knowledge/` as a build artifact.

## Get started: the desktop app

For people who should not need a terminal there is an installer for macOS (Apple Silicon) and Windows: one window with Open WebUI as the chat, already connected to the test runner, and the settings app's pages in a strip down the left side. Nothing else needs to be installed; the first start sets up Open WebUI by itself (this needs internet access). See [desktop/README.md](desktop/README.md).

## Get started from the project folder: chat in the settings app

The friendliest way to use the agent is the **Chat** tab of the settings app. It needs only Node.js 20 or later: no Docker, no Open WebUI.

```bash
npm install
npm run launcher:install   # once: builds and puts a "D365FO Agent" icon on your desktop
```

Double-click the icon (or run `npm run ui`). Then:

1. On **AI models**, add the AI model connection (provider, key, model name). On **Setup**, create a **profile** for your environment: F&O URL, test account or saved session, Azure DevOps settings, and which AI model its runs use. Secrets stay in the app and never reach the chat.
2. Open **Chat**, pick the chat's AI model at the top (one choice for every profile), and ask in plain words, for example *"Check my setup"*, *"Dry-run examples/testcases and tell me what failed"*, *"Write a test case that creates a vendor"* or *"Upload the last run to Azure DevOps"*. The chat has the same tools Open WebUI gets, and is told to ask before a real run or an upload.

### Prefer Open WebUI?

`npm run studio` starts the settings app, starts [Open WebUI](https://openwebui.com) in Docker with the **D365FO test runner** tools already connected, and opens `http://localhost:3000`. Pick a chat model with tool calling there and turn the tools on with the **+** button. No Docker? `studio` still starts the settings app and prints the address and key to add to any Open WebUI you already have. Details: [docs/openwebui.md](docs/openwebui.md).

## Fast and learning on F&O

The F&O web client is heavy: deep menus, forms that load asynchronously, and very large pages. The agent is built around that:

- **Direct form links.** Pages open by display menu item (`?cmp=<company>&mi=<MenuItem>`, Microsoft's deep-link format) in one step instead of clicking through the navigation pane.
- **Stable control names.** Playwright runs with F&O's `data-dyn-controlname` attribute as its test id, so a control resolves to `getByTestId('<AOT control name>')`, the same names Task Recorder and RSAT record. They do not change with language, release or personalisation.
- **Learns while it works.** Every control the agent uses is stored per form in `knowledge/pages.json` with how often it worked. The next time any test opens that form, the agent gets the list and acts on those controls directly, without reading the whole page first. Every form it visits also becomes openable by caption. The agent can add notes about a form ("Vendor group is on the General FastTab") with `d365_page_note`. Passing cases also keep their known-good path.
- **Waits for F&O, not for the model.** After each click or entry the run waits for F&O's *Please wait* overlay itself, and retries a learned control once when the form had not finished loading, so the model does not spend a turn on it.
- **Smaller pages for the model.** Anonymous wrapper nodes are dropped from page snapshots, older snapshots are collapsed, and the agent is told to search the page (`browser_find`) or snapshot one part of it instead of the whole form.

See [Self-learning](docs/self-learning.md) and [D365 F&O notes](docs/d365fo.md#fast-navigation-and-known-good-paths).

## Desktop icon and settings app

No terminal needed after the one-time `npm install` and `npm run launcher:install` shown above.

Double-click the icon: it starts a small local web app and opens it in your browser (macOS `.command`, Windows `.lnk`, Linux `.desktop`). Close the window it opens to stop. `npm run ui` does the same from a terminal; `npm run launcher:remove` removes the icon.

In the app you create **named profiles**, one per environment (for example "Sandbox UAT" and "Dev"), and choose the one in use. Profiles are stored in your user config folder, outside the project, with owner-only permissions (macOS `~/Library/Application Support/d365fo-agent`, Windows `%APPDATA%\d365fo-agent`, Linux `~/.config/d365fo-agent`; override with `D365FO_AGENT_HOME`). Secrets are masked in the browser. The server listens on `127.0.0.1` only and requires a per-machine token.

The app has seven tabs:

- **Setup**: profiles and their settings.
  - A first-run welcome walks through the three steps to a first run.
  - A "ready to run" checklist at the top shows what is still missing (F&O address, sign-in, AI model, in use), with a link to the field.
  - The profile picks its AI model from the shared list on the **AI models** tab.
  - Rarely changed settings sit under "More settings". Addresses and numbers are checked as you type, and unsaved changes are flagged before you leave.
  - **Check setup** runs `doctor` against the profile and shows each check with a pass, warning or problem mark, and the list of things to fix.
- **AI models**: one list of AI connections, set up once and shared (name, provider, API key, optional API address, model name, **Test connection**). Only the chosen provider's fields are shown. For Claude that includes **Claude API URL**, for sending requests through your own gateway or proxy (see [Providers](docs/providers.md#custom-claude-api-url)). A profile picks one for its runs; Chat picks one for every profile. "Used by" shows who uses a setup, and it cannot be deleted while in use. Keys are masked. Profiles from earlier versions are migrated on first start: each profile's model fields become a setup (identical ones are merged).
- **Chat**: ask in plain words; the AI model chosen at the top of the page (the same for every profile) checks the setup, writes test cases, starts runs and reads results with the app's own tools. It is told to ask before a real run or an upload.
- **Test cases**: open a folder inside the project (default `examples/testcases`), then create, edit, duplicate and delete local test cases with a step editor (action and expected result per step, reorderable). "Run this case" takes you to the Run tab with it selected.
- **Run**: shows which profile and environment the run will use. Run a local folder or an Azure DevOps plan/suite, a checklist of cases (all ticked; Select all / Clear), with dry run, upload, and (under "More options") tag and module filters, most urgent priority, retries, priority order and **AI model for this run** (the profile is not changed). A real run asks for confirmation first. The log streams live with a running tally, and **Stop** lets the run save its report before it ends.
- **Results**: a list of runs on the left (filter "Only <profile in use>"); the picked run shows its profile, mode and AI model, with pass/fail/blocked counts, and for each case that did not pass, its failure category, what to do about it, and the steps. Links to the HTML report and the JSON / JUnit XML downloads.
- **History**: every `run`, started from the app or the terminal, is kept with its reports under `<REPORT_DIR>/history/` (last 200). Each profile has its own report folder, `reports/<profile id>/`, unless it sets `REPORT_DIR`. The id is generated when the profile is created and never changes, so a profile can be renamed (Rename on the Setup tab) without losing its reports. Reopen any of them, download its reports, or upload it to Azure DevOps as a test run later, always with the profile the run belongs to (not the one in use now) and an optional plan id. The DevOps run link is shown once it is uploaded.

Checks and runs started from the app read the profile in use, not the `.env` file in the project folder. A variable set in the computer's real environment still wins over both, and **Check setup** warns when that happens.

The profile in use replaces `.env` for every command. Pick another per command with `--profile "Name"` (the permanent profile id works too, so renaming does not break scripts) or `D365FO_PROFILE=Name` (`D365FO_PROFILE=none` forces `.env`). The profile's AI model comes from the shared AI models; `--model <name or id>` uses another for one command. `run` records itself in the run history with its profile and model, so terminal runs show in Results and History, and `upload --input results.json` uses the profile the run belongs to unless `--profile` is given.

### Open WebUI

Prefer a chat? The app also serves an OpenAPI tool server for [Open WebUI](https://openwebui.com): `npm run openwebui:up` (the same as `npm run studio`) starts the settings app and Open WebUI in Docker, `npm run openwebui:down` stops the container, `npm run openwebui` prints the address and key to add under External Tools, and a chat model can then pick profiles, write test cases, run them, read results and upload them to Azure DevOps. See [docs/openwebui.md](docs/openwebui.md).

## Command line

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

# 7. Optional: fail fast when an MFA session has expired
node dist/cli/index.js run --local examples/testcases --probe-session

# 8. Run a subset, and fail CI only on real failures
node dist/cli/index.js run --local examples/testcases --module "Accounts payable" --tag smoke --max-priority 2 --fail-on failed
node dist/cli/index.js run --local examples/testcases --case TC-VENDOR-001,TC-SMOKE-LOGIN

# 9. Draft new test cases, review them, then run them
node dist/cli/index.js generate "create a vendor and post an invoice for it" --module "Accounts payable" --count 2
```

Cases run in the order they are discovered (suite or file order), so cases that depend on an earlier one keep working. `--sort-by-priority` runs the most urgent first instead; `--case` always runs the ids in the order you list them.

When the source and filters match no test case, `run` exits with code 1, and a `--case` id that matches nothing is reported as a warning. `run` also exits with code 1 when the configuration has a problem (the same checks as `doctor`), when `--probe-session` finds the session expired or the host unreachable, and when the run is aborted by an LLM provider problem (for example a refused API key) rather than by the tests. Number options such as `--max-priority` and `--count` reject anything that is not a whole number.

`--fail-on <outcomes>` makes `run` exit with code 2 when any case ends with one of the listed outcomes (`passed`, `failed`, `skipped`, `blocked`). Without it, failing cases do not change the exit code. Press Ctrl+C once to stop the run and write the reports (exit 130); press it again to quit at once. SIGTERM (a cancelled CI job, `kill`) does the same with exit code 143. On macOS and Linux the Playwright server is started in its own process group, so the first Ctrl+C does not kill the browser and the run can save its trace and close the browser cleanly (`MCP_SHIELD=false` turns this off); on Windows the browser may still close with the first Ctrl+C. The case that was running is marked interrupted: it is reported as blocked with the reason "Run interrupted, not a test result", it is not retried, nothing is learned from it, and it is never uploaded to Azure DevOps. Cases that had already finished keep their results.

Reports are written to `REPORT_DIR` (default `./reports`; with a profile that does not set `REPORT_DIR`, `./reports/<profile id>`) and the knowledge base to `KB_DIR` (default `./knowledge`, file `kb.json`). Each `run` also keeps a copy of its reports under `<REPORT_DIR>/history/`, which the app's Results and History tabs show.

The first `run` downloads the Playwright browser it needs (~300 MB, once); later runs only spend about a second checking it. Set `PW_AUTO_INSTALL=false` to skip this and install it yourself with `npx @playwright/mcp install-browser chrome-for-testing`.

## Configuration

All configuration is via environment variables (loaded from `.env`). See [`.env.example`](.env.example) for the full list. The essentials:

| Variable | Purpose |
| --- | --- |
| `LLM_PROVIDER` | `anthropic` (default), `openai`, `azure-openai`, `github-models`, `github-copilot`, `openai-compatible` (local models) |
| `ANTHROPIC_API_KEY` | Required when provider is `anthropic` |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` | Optional: a custom Claude API URL (gateway or proxy) and a bearer token for it, see [Providers](docs/providers.md#custom-claude-api-url) |
| `OPENAI_COMPATIBLE_MODEL` / `OPENAI_COMPATIBLE_BASE_URL` | Provider `openai-compatible`: model name and server URL (default Ollama, `http://localhost:11434/v1`) |
| `GITHUB_COPILOT_TOKEN` / `GITHUB_COPILOT_MODEL` | Provider `github-copilot`: token (or run `copilot-login` to save one) and model |
| `D365_BASE_URL` | Your F&O sandbox URL |
| `D365_USERNAME` / `D365_PASSWORD` | Test account credentials (non-MFA recommended for automated runs) |
| `D365_TENANT_ID` / `D365_CLIENT_ID` / `D365_CLIENT_SECRET` | Optional Entra app registration: read-only OData data checks (`d365_odata_query`), see [D365 F&O notes](docs/d365fo.md#entra-app-registration-optional) |
| `D365_ENVIRONMENT_TYPE` | Declare `sandbox` / `production` / `dev`; empty guesses from the URL (see [Grounding & safety](#grounding--safety)) |
| `D365_STORAGE_STATE` | Optional saved browser session (see [docs/d365fo.md](docs/d365fo.md#signing-in-with-a-saved-session-optional)); replaces the password when set |
| `AZDO_ORG_URL` / `AZDO_PROJECT` / `AZDO_PAT` | Azure DevOps ingestion + reporting. Leave `AZDO_PAT` empty to sign in with your Microsoft account (`d365fo-agent devops-login`, see [docs/azure-devops.md](docs/azure-devops.md)) |
| `AZDO_TEST_PLAN_ID` / `AZDO_TEST_SUITE_ID` | Default plan/suite to discover from |
| `PW_ACTION_TIMEOUT_MS` | How long an action waits for its element (default 15 s; F&O renders slowly) |
| `AGENT_LEARN_PAGES` / `AGENT_FNO_AUTO_WAIT` / `AGENT_SLIM_SNAPSHOTS` | F&O learning and speed-ups (all on by default): learn controls per form, wait for the busy overlay after actions, smaller snapshots |
| `AGENT_REPLAY` | Replay a case from its last passing run without the AI before asking the model (default `true`); see [Replay without the AI](docs/self-learning.md#replay-without-the-ai) |
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

Local test cases are JSON files following [`src/testing/types.ts`](src/testing/types.ts). Five examples live in [`examples/testcases`](examples/testcases). Azure DevOps test cases are read from the configured plan/suite; steps are extracted from `Microsoft.VSTS.TCM.Steps`.

## Grounding & safety

The agent is prompted as a **QA persona** that cites Microsoft Learn for product-behaviour claims and treats page, tool and knowledge-base content as untrusted data. The prompt is not the control, though. These guardrails are enforced in code:

- **Production block.** `run` refuses an environment that is, or looks like, production. Only LCS-managed sandboxes (`<name>.sandbox.operations…`) are recognised from the host; Power Platform (unified) environments use the same host format for sandbox and production, so declare them with `D365_ENVIRONMENT_TYPE=sandbox`. `AGENT_ALLOW_PRODUCTION=true` is the explicit override.
- **Tool allowlist.** Only a safe subset of the Playwright and Learn MCP tools is shown to the model, and calls to anything else are refused at dispatch. That keeps cookie/storage dumps, arbitrary JS, file access and network internals out of reach of a prompt-injected page. Opt tools in with `AGENT_ALLOWED_TOOLS_EXTRA`.
- **Navigation and legal entity.** Model-requested navigation is limited to the F&O host and Microsoft sign-in (extend with `AGENT_ALLOWED_HOSTS`), and `cmp=` company links must match the test's legal entity (`legalEntity` in the test case, else `D365_COMPANY`). Redirects the browser follows on its own are not intercepted.
- **Scrubbed, bounded results.** Configured secrets and token-shaped strings are redacted, and sizes capped, before model-written text reaches reports, the knowledge base or Azure DevOps. Invalid tool arguments are rejected instead of recorded.
- **Audit trail.** Every refused call is listed under `policyBlocks` in `results.json` and in the HTML report; an attempt that keeps probing the guardrails is stopped.
- **Run limits per attempt.** A page, menu item or path that cannot be opened is never retried (navigating to it again is refused), the step is reported blocked and the run moves on, and the test is not re-run by the reloop; after `AGENT_MAX_UNREACHABLE_TARGETS` (3) different missing pages it stops. MFA prompts and refused sign-ins stop the test at once (`AGENT_STOP_ON_AUTH_FAILURE`). Also bounded: wall-clock time (`AGENT_TEST_TIMEOUT_MS`), tokens (`AGENT_MAX_TOKENS_PER_TEST`), failing tool calls in a row (`AGENT_MAX_CONSECUTIVE_ERRORS`), identical calls in a row (`AGENT_MAX_REPEATED_CALLS`) and model turns (`AGENT_MAX_STEPS`, raised to 4 turns per test step for long cases). `0` turns a limit off (except `AGENT_MAX_STEPS`).
- **Optional session preflight.** `run --probe-session` asks `D365_BASE_URL` whether the saved session is still accepted (same probe as `doctor --probe`) and fails before test execution when the session is expired or the host is unreachable.
- **No destructive clicks.** Clicks on controls labelled delete, remove, purge, void and the like (by label or by F&O control name, such as `SystemDefinedDeleteButton`) are refused unless `AGENT_ALLOW_DESTRUCTIVE=true`.
- **Dry-run** (`AGENT_DRY_RUN=true` / `--dry-run`) skips state-changing browser tools.

Redaction cannot recognise arbitrary business data (customer names, amounts) that a page shows, so treat `reports/` and `knowledge/` as sensitive.

## Documentation

- [Desktop app and installer](desktop/README.md)
- [Open WebUI front end](docs/openwebui.md)
- [Providers](docs/providers.md)
- [Azure DevOps setup](docs/azure-devops.md)
- [D365 F&O notes](docs/d365fo.md)
- [Self-learning](docs/self-learning.md) (including [replay without the AI](docs/self-learning.md#replay-without-the-ai))
- [Skills for coding agents](skills/README.md)
- [Sandbox verification checklist](docs/sandbox-checklist.md)

## License

MIT — see [LICENSE](LICENSE).
