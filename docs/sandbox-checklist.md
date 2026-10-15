# Sandbox verification checklist

Some F&O-specific behaviour the agent relies on comes from Microsoft FastTrack samples rather than a documented contract: the session cookie names (`DynamicsOwinAuth`, `ms-dyn-csrftoken`), the redirect to the Microsoft sign-in page when a session has expired, the `data-dyn-controlname` attribute and the "Please wait" overlay. Run this on a machine that can reach a sandbox and record the answers (a line each is enough).

Use a non-production sandbox and a test account. Never paste passwords, cookie values or session files into notes, issues or chat.

## 1. Sign-in and session

1. `d365fo-agent session-login`, sign in (MFA included), wait for the F&O dashboard, close the window. Set `D365_STORAGE_STATE` to the saved file.
2. `d365fo-agent doctor --probe`. Expected: saved session `OK`, no `DynamicsOwinAuth` warning, probe `LIVE`.
   - If a `DynamicsOwinAuth` warning appears: note the real F&O cookie names in the saved file (names only, never values). The names the check looks for are `F_AND_O_AUTH_COOKIE` and `F_AND_O_CSRF_COOKIE` in `src/d365fo/session.ts`.
   - If the probe says `UNREACHABLE` or wrongly `EXPIRED`: note the HTTP status and redirect host it reports.
3. Wait past `D365_SESSION_MAX_AGE_HOURS` and re-run `doctor --probe`. Expected: saved session `STALE`; the probe says whether the server still accepts it (`LIVE`) or not (`EXPIRED`). Then sign out of that session in another browser, or wait until F&O drops it, and confirm the probe reports `EXPIRED`.

## 2. Test cases

4. `node dist/cli/index.js run --local examples/testcases --case TC-SMOKE-LOGIN`. Note whether it passes and whether every step with an `expected` result was reported verified.
5. Run `TC-VENDOR-001` (`--case TC-VENDOR-001`). Note which steps needed retries, which waits were too short or long, and any form quirks (lookups, busy indicators, dialogs).
6. Check what the runs learned: `<KB_DIR>/pages.json` should list the forms used with `getByTestId('<control name>')` targets, and `node dist/cli/index.js learn --stats` should show a known-good path for each passing case. Add any menu item that `d365_open_menu_item` could not open to `<KB_DIR>/menu-items.json`.
7. Run `TC-SMOKE-LOGIN` again. Expected: the run log says it is replaying the recorded run without the AI (or why it is not), and the report marks the case as replayed.

## 3. Run features

8. Time budgets: set `AGENT_TOOL_TIMEOUT_MS=5000` for one run and confirm a slow call is reported as a timeout in `results.json` (`timeouts`).
9. Trace: with `PW_TRACE=on-failure`, force a failing case and confirm a `.trace` file under `<REPORT_DIR>/playwright-output/traces/` is attached to that result and that a passing case leaves no trace.
10. Verification: confirm a case whose expected result cannot be checked ends `blocked`, not `passed`.
11. Recorded values: confirm `record_value` values show in `results.json` (`data`) and the HTML report.

## 4. Optional

12. Release Planner MCP: run the FastTrack Release Planner MCP server, set `RELEASE_PLANNER_MCP_URL`, and run a case. Confirm the run connects to it and that its three read-only tools (`search_release_plans`, `list_products`, `get_release_wave_summary`) are not in the run log's "hiding N tool(s) not on the allowlist" line. Check that the server still returns current release-plan data.
