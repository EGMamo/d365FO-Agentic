# Azure DevOps setup

The agent connects to Azure DevOps through its REST API (version 7.1) ([`src/devops/client.ts`](../src/devops/client.ts)). Reading test cases and uploading results always use this client. It signs in one of two ways:

- **Your Microsoft work account (recommended).** No token to create, store or renew: the agent uses the account the Azure CLI is signed in with.
- **A personal access token (PAT)**, as before.

`AZDO_USE_MCP=true` registers the Azure DevOps MCP server (`@azure-devops/mcp`) in the server list, but a run only connects to the Playwright, Microsoft Learn and (when configured) Release Planner servers, so the setting currently has no effect.

## Sign in with your Microsoft account

1. Install the Azure CLI once. On Windows: `winget install -e --id Microsoft.AzureCLI`, then reopen the app.
2. Leave **Personal access token** empty and press **Sign in to Azure DevOps** in the settings app (or run `d365fo-agent devops-login`). The Microsoft sign-in opens in your browser; MFA and company sign-in pages work as usual.
3. **Check setup** (or `d365fo-agent doctor`) then shows `Azure DevOps: OK - … signed in as you@company.com, project … found`.

The agent asks the Azure CLI for a short-lived token (`az account get-access-token`) when it needs one, so the sign-in lasts as long as the Azure CLI's (usually weeks). When it expires, the check says so and you press the button again. Your account needs access to the test plan in Azure DevOps; no Azure subscription is needed.

If your account belongs to several organizations' Microsoft tenants and the sign-in is refused, set **Microsoft tenant** (`AZDO_TENANT_ID`) to the tenant ID or domain of the Azure DevOps organization and sign in again.

## Sign in with a personal access token

Set `AZDO_PAT`. When a token is set it is used; to switch to your Microsoft account, clear it (or set `AZDO_AUTH=azure-cli`). `AZDO_AUTH=pat` makes a missing token an error instead of falling back to the Azure CLI.

Required scopes:

- **Work Items** — Read (to read the test case work items and their steps)
- **Test Management** — Read & Write (to list suite test cases, create test runs, publish results, upload attachments)

## Environment

```env
AZDO_ORG_URL=https://dev.azure.com/your-org
AZDO_PROJECT=YourProject
# AZDO_PAT=...             # optional: without it, the Azure CLI sign-in is used
# AZDO_AUTH=azure-cli      # optional: pat or azure-cli; default picks the PAT when set
# AZDO_TENANT_ID=contoso.onmicrosoft.com  # optional: only for accounts in several tenants
AZDO_TEST_PLAN_ID=1234
AZDO_TEST_SUITE_ID=5678
```

`--plan` and `--suite` on `discover` and `run` override the plan and suite ids; `--plan` on `upload` overrides the plan id. Requests time out after `AZDO_HTTP_TIMEOUT_MS` (default 60 s) and are retried up to `AZDO_HTTP_MAX_RETRIES` times (default 3) with a backoff starting at `AZDO_HTTP_RETRY_BASE_MS` (default 800 ms).

## Test cases

The agent lists the suite's test cases from `Plans/<planId>/Suites/<suiteId>/testcases`, then reads the work items' title, area path, tags (split on `;`), priority and `Microsoft.VSTS.TCM.Steps`. Each step's first parameterized string becomes the action and the second the expected result. If the field has no `<step>` elements (for example plain text), the parser falls back to one step per line, without expected results. Nothing else is read from the test case: attachments such as Task recorder recordings or RSAT Excel parameter files are ignored.

`d365fo-agent discover --plan <id> --suite <id>` lists what would run; `--output <file>` writes the parsed cases as JSON.

## Runs & results

`d365fo-agent run --upload` (after the run) or `d365fo-agent upload --input results.json` will:

1. Create a new automated Test Run under the configured Test Plan, state InProgress.
2. Publish one Test Result per test case, mapped to Passed / Failed / Blocked / NotExecuted (skipped), with duration and error message. A result is linked to its test case when the case id is numeric (an Azure DevOps work item id); local cases with other ids are published by title only.
3. Attach the artifacts the agent captured for each case (screenshots, Playwright traces).
4. Mark the Test Run as Completed.

Cases stopped by Ctrl+C are not published, and a run aborted by a model-provider outage is not uploaded. A failed attachment upload is logged and skipped; it does not fail the upload.

## Troubleshooting

- **Refused sign-in (401 or 203)** — With a PAT, create a new one with the scopes above. With your Microsoft account, press **Sign in to Azure DevOps** again, and set `AZDO_TENANT_ID` if your account is in several tenants.
- **Azure CLI is not installed** — Install it (above), or use a PAT.
- **404 on `Plans/.../testcases`** — The signed-in account (or the PAT's user) must have access to the test plan.
- **`Microsoft.VSTS.TCM.Steps` missing** — Some legacy plans use unstructured text. Add steps in the DevOps Test Plans UI or provide a local test case JSON as a fallback (`--local <dir>`).
