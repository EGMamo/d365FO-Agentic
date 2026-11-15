# d365FO-Agentic

A desktop assistant for testing Microsoft Dynamics 365 Finance & Operations sandboxes. Open WebUI provides the chat experience; Claude executes test cases through Playwright and checks expected results against the F&O pages.

## The workflow

The app has four destinations:

- **Chat:** check setup, choose an environment and cases, follow runs, explain results, and upload a selected result. Open WebUI retains its conversation history, composer, themes, and branding.
- **Tests:** edit local test-case files or load cases from an Azure DevOps plan and suite. Select cases and run them in order. Progress and Stop are available in a shared execution panel.
- **Results:** current and previous runs, step observations, failure reasons, evidence, HTML/JSON/JUnit downloads, and Azure DevOps upload.
- **Settings:** environment profiles, one shared Claude connection, and optional Azure DevOps sign-in.

Essential test and result actions work without chat. If Open WebUI fails to start, Tests, Results, and Settings remain usable; restart the app to retry Chat.

## Setup

Use the desktop installer, or build it as described in [desktop/README.md](desktop/README.md).

1. In **Settings**, create an environment with its F&O sandbox URL, sign-in, and legal entity. Use a saved session for accounts requiring MFA, or a test username/password.
2. Enter your Claude API key in **Shared AI connection** and press **Test connection**. Chat and all test runs use this connection; there is no second model to configure in Open WebUI. Model name and corporate gateway settings are under Advanced.
3. Choose **Use this environment**, then **Check setup**.
4. In **Tests**, load local cases or an Azure DevOps plan/suite, select cases, and run them. Real runs ask for confirmation.
5. Review the evidence in **Results**. Upload a selected run explicitly when needed.

Azure DevOps supports Microsoft-account sign-in through the Azure CLI, or a PAT under Advanced. See [docs/azure-devops.md](docs/azure-devops.md).

## What the runner keeps

- Browser execution with Microsoft Learn grounding and structured step verdicts.
- Expected-result verification: an unchecked expected result cannot become a passing live test.
- F&O direct page links, stable control names, busy/loading waits, and smaller snapshots.
- A small local map of learned forms and controls, including UK vendor/supplier aliases.
- Values recorded within a case, bounded execution, cancellation, screenshots, and failure traces.
- Missing-data/TBC handling: generate new unique values only where the case asks to create them; block unspecified existing data.
- Production, host, tool, legal-entity, and destructive-action restrictions; secret masking.

Cases run independently. An earlier case's recorded values are not automatically handed to later cases. Prepare shared prerequisites explicitly. Rerun a selected case manually when appropriate; there are no automatic case reloops or recorded-code replays.

The Advanced diagnostic skips mutating browser actions. It does not demonstrate that sign-in or a business workflow succeeds.

## Development

Node.js 20 or later:

```bash
npm ci
npm run lint
npm test
npm run build
npm run ui -- --no-open
```

Playwright is pinned to the exact `1.64.0-alpha` build that the bundled `@playwright/mcp` (see `desktop/package.json` → `bundle.playwrightMcp`) depends on, so the whole stack runs one Playwright. Bump both together, or `npm audit`/install will resolve two conflicting copies.

`ui` starts the local Tests/Results/Settings pages for development. The packaged desktop app supplies Open WebUI Chat; the browser-only UI has no second chat engine. See [docs/openwebui.md](docs/openwebui.md).

Internal CLI examples:

```bash
node dist/cli/index.js doctor
node dist/cli/index.js discover --local examples/testcases
node dist/cli/index.js run --local examples/testcases --case TC-SMOKE-LOGIN --fail-on failed,blocked
node dist/cli/index.js run --plan 1234 --suite 5678 --fail-on failed,blocked
node dist/cli/index.js upload --input reports/results.json --plan 1234
node dist/cli/index.js session-login
```

An explicit `--profile` selects an environment by name or permanent ID. The shared AI connection still applies. Genuine process environment variables override saved settings; the setup check reports overrides. Without an active profile, the CLI can read `.env` (see [.env.example](.env.example)).

## Existing installations

Before the first simplified startup, configuration is copied to `backups/before-simplification-v1` in the agent's settings folder, with private file permissions. The shared connection is migrated from a usable selected chat connection, otherwise the active environment's Claude connection. Unsupported old providers need a new Claude connection in Settings; their original files remain in the backup.

Environment IDs, custom report paths, saved sessions, Open WebUI conversations, and previous reports remain in place. Legacy model, knowledge-base, and replay files are left untouched and unused. The migration is repeatable and does not reset edited shared settings.

The application no longer exposes Docker studio, built-in fallback chat, model catalogs/overrides, general knowledge-base ranking/pruning, replay/export, automatic case retries, standalone case generation, OData app registrations, Release Planner, or Azure DevOps MCP. Azure DevOps uses its ordinary REST API.

## Further documentation

- [Desktop builds and smoke tests](desktop/README.md)
- [Open WebUI integration and its limits](docs/openwebui.md)
- [Claude configuration](docs/providers.md)
- [F&O sign-in, evidence, and safety](docs/d365fo.md)
- [Learned form map](docs/self-learning.md)
- [Sandbox validation checklist](docs/sandbox-checklist.md)
- [License](LICENSE)
