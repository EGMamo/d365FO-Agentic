# Azure DevOps setup

The agent connects to Azure DevOps via a **Personal Access Token (PAT)** stored in `.env`. The Azure DevOps MCP server can be used as an alternative by setting `AZDO_USE_MCP=true` (experimental).

## Required PAT scopes

At minimum:

- **Work Items** — Read (to enumerate test cases)
- **Test Management** — Read & Write (to create test runs, publish results, upload attachments)

## Environment

```env
AZDO_ORG_URL=https://dev.azure.com/your-org
AZDO_PROJECT=YourProject
AZDO_PAT=...
AZDO_TEST_PLAN_ID=1234
AZDO_TEST_SUITE_ID=5678
```

## Test cases

The agent reads test cases from `Plans/<planId>/Suites/<suiteId>/testcases`. Steps are parsed from the `Microsoft.VSTS.TCM.Steps` XML field. If the field is empty or non-XML the parser falls back to line-splitting, so simple text steps also work.

## Runs & results

`d365fo-agent run --upload` (or `d365fo-agent upload --input results.json`) will:

1. Create a new automated Test Run under the configured Test Plan.
2. Publish one Test Result per test case, mapped to Passed / Failed / Blocked / NotExecuted.
3. Attach any artifacts (screenshots, traces) that the agent captured.
4. Mark the Test Run as Completed.

## Troubleshooting

- **401 Unauthorized** — Regenerate the PAT with the scopes above.
- **404 on `Plans/.../testcases`** — The user associated with the PAT must have access to the test plan.
- **`Microsoft.VSTS.TCM.Steps` missing** — Some legacy plans use unstructured text. Add steps in the DevOps Test Plans UI or provide a local test case JSON as a fallback.
