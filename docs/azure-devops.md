# Azure DevOps setup

The agent connects to Azure DevOps through its REST API (version 7.1) with a **Personal Access Token (PAT)** stored in `.env` or a settings profile ([`src/devops/client.ts`](../src/devops/client.ts)). Reading test cases and uploading results always use this client.

`AZDO_USE_MCP=true` registers the Azure DevOps MCP server (`@azure-devops/mcp`) in the server list, but a run only connects to the Playwright, Microsoft Learn and (when configured) Release Planner servers, so the setting currently has no effect.

## Required PAT scopes

At minimum:

- **Work Items** — Read (to read the test case work items and their steps)
- **Test Management** — Read & Write (to list suite test cases, create test runs, publish results, upload attachments)

## Environment

```env
AZDO_ORG_URL=https://dev.azure.com/your-org
AZDO_PROJECT=YourProject
AZDO_PAT=...
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

- **401 Unauthorized** — Regenerate the PAT with the scopes above.
- **404 on `Plans/.../testcases`** — The user associated with the PAT must have access to the test plan.
- **`Microsoft.VSTS.TCM.Steps` missing** — Some legacy plans use unstructured text. Add steps in the DevOps Test Plans UI or provide a local test case JSON as a fallback (`--local <dir>`).
