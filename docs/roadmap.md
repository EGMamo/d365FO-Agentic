# Roadmap: next changes to the agent

Ranked implementation plan from a review of Microsoft's
[Dynamics-365-FastTrack-Implementation-Assets](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets) repo (snapshot 2026-09-21), including a deeper read of its
Customer Service Playwright sample and its F&O JMeter samples. That repo has no F&O UI automation, RSAT or Azure DevOps
Test Plans content, so several items are marked as inference and need checking against a real sandbox. The UI-shell plan
is in [desktop-roadmap.md](desktop-roadmap.md).

Each item has a scope, the files likely touched, an acceptance check and the supporting FastTrack link. Items marked **Done** are implemented; the rest are plan only.

| # | Item |
|---|------|
| 1 | Stronger saved-session check in `doctor` (Done) |
| 2 | Optional live session probe (Done) |
| 3 | MFA and non-MFA setup guide (Done) |
| 4 | Sign-out policy (Done) |
| 5 | Wait and timeout budgets (done) |
| 6 | Assertion discipline (done) |
| 7 | Per-run data bag (done) |
| 8 | Playwright trace on failed steps (done) |
| 9 | Real sandbox runs and knowledge seeding (checklist ready, needs your sandbox) |
| 10 | RSAT and Azure DevOps Test Plans study (design note done) |
| 11 | Release Planner MCP (optional) (done) |
| 12 | API-side test data setup (evaluate) (design note done) |
| 13 | FastTrack agents as end-to-end test subjects (done) |

## 1. Stronger saved-session check in `doctor`

**Done.** `checkSession` warns when `DynamicsOwinAuth` or `ms-dyn-csrftoken` is missing. It is a warning, not a failure, because the cookie names are unconfirmed on a real deployment.

- **Scope:** `checkSession` also requires the F&O session cookie `DynamicsOwinAuth` for the F&O host and warns when `ms-dyn-csrftoken` is missing. Today any cookie for the host passes.
- **Files likely touched:** `src/d365fo/session.ts`, `src/d365fo/session.test.ts`, `docs/d365fo.md`
- **Acceptance check:** A storage state with only Entra cookies is reported `ok` with a warning carrying the `session-login` hint; one with `DynamicsOwinAuth` has no warning. Unit tests cover both.
- **Source:** [JMeter cookie sample](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets/blob/master/Administration/Performance/Jmeter/Sample/MFA_DynamicsOWinAuth_POCreation.jmx) names the three cookies. Inference: a file without `DynamicsOwinAuth` cannot be a valid F&O login.

## 2. Optional live session probe

**Done** as `doctor --probe`, implemented as one HTTP request with the saved host cookies rather than a headless browser (cheaper, no browser needed). Not run before `run`.

- **Scope:** `doctor --probe` (and optionally before `run`) opens the F&O URL headless with the saved session and reports `expired` if it lands on `login.microsoftonline.com`. No test steps run.
- **Files likely touched:** `src/d365fo/session.ts`, `src/cli/index.ts`, `src/mcp/playwright-browser.ts`, `docs/d365fo.md`
- **Acceptance check:** With an expired file `doctor --probe` exits non-zero with the renewal hint; with a valid one it reports `live`. Never writes to the session file.
- **Source:** Cookies in the [JMeter sample](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets/blob/master/Administration/Performance/Jmeter/Sample/MFA_DynamicsOWinAuth_POCreation.jmx) are session cookies (`expires 0`), so file age (`D365_SESSION_MAX_AGE_HOURS`) is a weak signal. Inference.

## 3. MFA and non-MFA setup guide

**Done** in `docs/d365fo.md` (Authentication section: no-MFA and MFA routes).

- **Scope:** Document both routes: a dedicated test account excluded from security defaults / Conditional Access, or `session-login` for MFA accounts, and what renewal looks like for scheduled runs.
- **Files likely touched:** `docs/d365fo.md`, `README.md`
- **Acceptance check:** A reader can choose a route and finish setup from the doc alone; the tenant-level security trade-off is stated.
- **Source:** [Playwright setup guide](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets/blob/master/Customer%20Service/Customer%20Service/Testing/Automation/Playwright/Documentation) (security defaults off, dedicated account); the JMeter folder has [enabled login and cookie-injection variants](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets/blob/master/Administration/Performance/Jmeter/Sample) side by side.

## 4. Sign-out policy

**Done** (docs and prompt rule). Decision: never sign out, for saved sessions and password logins alike; the optional sign-out step is not adopted.

- **Scope:** Decide and document: never sign out a saved session (it would end the session we reuse); optionally sign out for password logins so F&O user sessions are freed. Note per-user session limits for parallel runs.
- **Files likely touched:** `src/d365fo/guidance.ts`, `docs/d365fo.md` (code only if the optional sign-out is adopted)
- **Acceptance check:** Docs state the policy; if implemented, a password-login run ends with a sign-out step and a saved-session run does not.
- **Source:** The JMeter script ends with `/Logout` and `Services/SessionManager.svc/EndSessions` ([sample](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets/blob/master/Administration/Performance/Jmeter/Sample/MFA_DynamicsOWinAuth_POCreation.jmx)). Whether it kills the cookie is not verified.

## 5. Wait and timeout budgets (done)

**Done.** `AGENT_TOOL_TIMEOUT_MS` / `AGENT_NAV_TIMEOUT_MS` bound each MCP call (passed to the MCP client); timeouts are reported and recorded as `timeouts`; F&O waiting rules added to the agent guidance. Values are untuned.

- **Scope:** Configurable per-step wait/timeout budgets (defaults about 30 s action, 60 s navigation, 180 s heavy pages) and an F&O rule: after every action wait for the shell/busy state to settle, then re-snapshot. A wait that fails is recorded on the step, never swallowed.
- **Files likely touched:** `src/config/index.ts`, `src/agent/orchestrator.ts`, `src/d365fo/guidance.ts`, `src/agent/prompts.ts`
- **Acceptance check:** Env vars documented in `.env.example`; a step whose wait times out reports the timeout in `results.json`; unit test on the budget parsing.
- **Source:** [`TimeOut` enum and `waitUntilAppIdle`](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets/blob/master/Customer%20Service/Customer%20Service/Testing/Automation/Playwright/Samples/automation/utils/common.ts) (the sample ignores wait failures, which we should not copy). The F&O client polls asynchronously (`__TimerForAsyncTaskPolling` controls in the JMeter script). Values are from the sample; F&O values need sandbox tuning.

## 6. Assertion discipline (done)

**Done.** `report_step` requires `verified` for a passed step with an expected result; unverified passes end `blocked`. Dry runs are exempt.

- **Scope:** Every test-case step with an `expected` result must end verified or explicitly `unverified`; a run cannot pass on steps that only ran without checking.
- **Files likely touched:** `src/agent/prompts.ts`, `src/agent/orchestrator.ts`, `src/testing/types.ts`, `src/reporting/reporters.ts`
- **Acceptance check:** A step with `expected` and no verification is shown as unverified in the report and does not count as passed; test covers the orchestrator boundary.
- **Source:** The sample's [16 tests](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets/blob/master/Customer%20Service/Customer%20Service/Testing/Automation/Playwright/Samples/automation/tests) contain no real assertions (`expect(locator).toBeTruthy()` is always true), so "passing" verifies nothing.

## 7. Per-run data bag (done)

**Done** as `record_value` / `recall_values`; values appear in `results.json` and the HTML report.

- **Scope:** Values created during a run (a generated vendor account, an order number) are stored on the run and available to later steps and to the report, replacing hand-carried values.
- **Files likely touched:** `src/testing/types.ts`, `src/core/runner.ts`, `src/agent/context.ts`, `src/reporting/reporters.ts`
- **Acceptance check:** TC-VENDOR-001 can reuse the vendor account it generated in a later step, and it appears in `results.json`.
- **Source:** The sample passes `CASE_NUMBER` between specs through `.env` ([`casecrud.spec.ts`](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets/blob/master/Customer%20Service/Customer%20Service/Testing/Automation/Playwright/Samples/automation/tests-e2e/casecrud.spec.ts)); this is the fragile pattern to replace.

## 8. Playwright trace on failed steps (done)

**Done, with a change.** `@playwright/mcp` has no `--save-trace` flag. The agent uses its `browser_start_tracing` / `browser_stop_tracing` tools (`--caps devtools`) per attempt; verified against `@playwright/mcp` 0.0.83 in a sandbox with a local page, not against F&O.

- **Scope:** Save a Playwright trace next to the existing failure screenshot when a step fails (through the MCP server's trace option, if it supports it).
- **Files likely touched:** `src/mcp/registry.ts`, `src/agent/orchestrator.ts`, `src/reporting/reporters.ts`
- **Acceptance check:** A failed step links a trace file in the HTML report; passing runs create none.
- **Source:** [`trace: 'on-first-retry'`](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets/blob/master/Customer%20Service/Customer%20Service/Testing/Automation/Playwright/Samples/automation/playwright.config.ts). Screenshots already exist in `src/agent/orchestrator.ts`.

## 9. Real sandbox runs and knowledge seeding (checklist ready, needs your sandbox)

**Not done: needs your sandbox.** See [sandbox-checklist.md](sandbox-checklist.md).

- **Scope:** Run TC-SMOKE-LOGIN and TC-VENDOR-001 against a real sandbox and keep the learned selectors, waits and form quirks in the knowledge base (never committed).
- **Files likely touched:** `knowledge/kb.json` (local), `docs/d365fo.md`
- **Acceptance check:** Both cases pass on a sandbox; a short list of confirmed F&O waits and control names is added to `docs/d365fo.md`.
- **Source:** No upstream source: FastTrack has no F&O UI selectors. Protocol control names such as `SystemDefinedSaveButton` appear in the [JMeter script](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets/blob/master/Administration/Performance/Jmeter/Sample/MFA_DynamicsOWinAuth_POCreation.jmx); whether they match DOM control names is an inference to check.

## 10. RSAT and Azure DevOps Test Plans study (design note done)

**Design note done:** [rsat-and-test-plans.md](rsat-and-test-plans.md). Key finding: Learn says RSAT will not be supported after May 15, 2027.

- **Scope:** Read the RSAT and Test Plans docs on Microsoft Learn and decide whether to import RSAT-style parameter data and shared parameters. Output is a design note.
- **Files likely touched:** `docs/azure-devops.md`, `src/devops/client.ts` (later)
- **Acceptance check:** A short design note states what is supported, what is not, and the first import step.
- **Source:** None: FastTrack has no RSAT or Test Plans content (gap).

## 11. Release Planner MCP (optional) (done)

**Done.** Set `RELEASE_PLANNER_MCP_URL`; the three read-only tools are allowlisted. Caveat from Learn: release plans stop being published in September 2026, so check the data is still current.

- **Scope:** Register the Release Planner MCP server as an optional MCP server so the agent can propose regression areas per release wave.
- **Files likely touched:** `src/mcp/registry.ts`, `src/config/index.ts`, `docs/d365fo.md`
- **Acceptance check:** With the server enabled the agent can list next-wave features for a module; disabled by default; no credentials needed.
- **Source:** [Release Planner](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets/tree/master/Agents/Implementation%20Agents/Release%20Planner) (TypeScript MCP, MIT, public API).

## 12. API-side test data setup (evaluate) (design note done)

**Design note done:** [test-data-setup.md](test-data-setup.md). Microsoft's Dynamics 365 ERP MCP server has data, form and action tools; authentication for our own MCP client is not yet understood.

- **Scope:** Evaluate a `setup` block in test-case JSON that seeds data through OData or the F&O MCP server, so UI tests check behaviour and not data entry. Start with a design note.
- **Files likely touched:** `src/testing/types.ts`, `src/testing/loader.ts`, `docs/d365fo.md`
- **Acceptance check:** Note compares OData and F&O MCP for one seeded record and names the guardrails needed (sandbox only, legal entity).
- **Source:** [Inventory Fulfillment Agent](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets/tree/master/Agents/AI%20ERP%20Agents/Inventory%20Fulfillment%20Agent) (F&O over MCP), [Warehouse App Task Validation](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets/tree/master/Administration/Performance/Warehouse%20App%20Task%20Validation) (data seeding outside the UI).

## 13. FastTrack agents as end-to-end test subjects (done)

**Done.** Three sandbox-only example cases in `examples/testcases/` (`agent-*.json`), covered by a loader test.

- **Scope:** Add sandbox-only test cases that verify what the Sales Order and User Onboarding agents write to F&O, and role/SoD checks from the Compliance Advisor.
- **Files likely touched:** `examples/testcases/`, `docs/d365fo.md`
- **Acceptance check:** One example case per agent, marked sandbox-only, with expected results stated.
- **Source:** [AI ERP Agents](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets/tree/master/Agents/AI%20ERP%20Agents).

Notes: do not copy the FastTrack sample's habit of committing session files or `.env`; keep `.d365fo-session/` gitignored. The four JMeter blog posts linked from its README (cookie handling tips) were not readable when this plan was written; read them before starting items 1 to 4.
