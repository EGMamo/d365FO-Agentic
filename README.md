# d365FO-Agentic

Portable AI agent for end-to-end regression and unit testing of Microsoft **Dynamics 365 Finance & Operations**. It drives the F&O web client through the [Playwright MCP server](https://github.com/microsoft/playwright-mcp), grounds itself on official Microsoft documentation via the [Microsoft Learn MCP server](https://learn.microsoft.com/en-us/training/support/mcp), and reads test cases from **Azure DevOps** (Test Plans / Test Suites) — publishing results back to a Test Run with attachments.

The agent is **LLM-agnostic** and ships with adapters for:
- **Anthropic Claude** (default)
- **OpenAI**
- **Azure OpenAI**
- **GitHub Models / Copilot**

It maintains a **local knowledge base** so it can learn selectors, recipes, and remediations across runs.

> **MVP status.** This repository is an MVP scaffold: it wires the LLM ↔ MCP ↔ Azure DevOps ↔ D365 F&O loop with an extensible tool-use protocol. Battle-hardening for specific F&O modules is expected to grow through the knowledge base and iterative use.

## Features

- Plan → act → report loop with pluggable LLM providers.
- MCP client for stdio (Playwright) and HTTP streamable (Learn) servers.
- Azure DevOps ingestion of test cases + publishing of test runs, results, and attachments (PAT via `.env`).
- Deterministic, structured reports: HTML, JSON, JUnit XML.
- Self-learning knowledge base (`knowledge/kb.json`) with keyword retrieval.
- Dry-run mode that plans without mutating the target environment.
- CLI: `doctor`, `discover`, `run`, `report`, `upload`, `learn`.
- GitHub Actions workflow for scheduled or on-demand runs.

## Quick start

```bash
# 1. Install
npm install
npm run build

# 2. Configure
cp .env.example .env
# fill in ANTHROPIC_API_KEY, D365_BASE_URL, and (optionally) Azure DevOps + F&O creds

# 3. Sanity check
node dist/cli/index.js doctor

# 4. Run against the local example test cases (dry-run first!)
node dist/cli/index.js run --local examples/testcases --dry-run

# 5. Real run + upload to Azure DevOps
node dist/cli/index.js run --plan 1234 --suite 5678 --upload
```

Reports are written to `./reports` and the knowledge base to `./knowledge/kb.json`.

## Configuration

All configuration is via environment variables (loaded from `.env`). See [`.env.example`](.env.example) for the full list. The essentials:

| Variable | Purpose |
| --- | --- |
| `LLM_PROVIDER` | `anthropic` (default), `openai`, `azure-openai`, `github-models` |
| `ANTHROPIC_API_KEY` | Required when provider is `anthropic` |
| `D365_BASE_URL` | Your F&O sandbox URL |
| `D365_USERNAME` / `D365_PASSWORD` | Test account credentials (non-MFA recommended for automated runs) |
| `AZDO_ORG_URL` / `AZDO_PROJECT` / `AZDO_PAT` | Azure DevOps ingestion + reporting |
| `AZDO_TEST_PLAN_ID` / `AZDO_TEST_SUITE_ID` | Default plan/suite to discover from |

## Test-case format

Local test cases are JSON files following [`src/testing/types.ts`](src/testing/types.ts). Two examples live in [`examples/testcases`](examples/testcases). Azure DevOps test cases are read from the configured plan/suite; steps are extracted from `Microsoft.VSTS.TCM.Steps`.

## Grounding & safety

The agent is prompted as a **QA persona** that:
- Cites Microsoft Learn when making product-behavior claims.
- Only calls whitelisted MCP tools (`browser_*`, `microsoft_docs_*`, `kb_*`, `report_step`, `finish_test`).
- Refuses to perform destructive actions outside the configured legal entity.
- Runs in **dry-run** mode when `AGENT_DRY_RUN=true` or `--dry-run` is passed.

## Documentation

- [Providers](docs/providers.md)
- [Azure DevOps setup](docs/azure-devops.md)
- [D365 F&O notes](docs/d365fo.md)
- [Self-learning](docs/self-learning.md)

## License

MIT — see [LICENSE](LICENSE).
