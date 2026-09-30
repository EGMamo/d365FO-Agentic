# Sandbox verification checklist

Nothing in this project has been run against a real F&O environment yet. The FastTrack review produced several behaviours that are inferred, not confirmed. Run this on a machine that can reach a sandbox and record the answers (a line each is enough).

Use a non-production sandbox and a test account. Never paste passwords, cookie values or session files into notes, issues or chat.

## 1. Sign-in and session

1. `d365fo-agent session-login`, sign in (MFA included), wait for the F&O dashboard, close the window.
2. `d365fo-agent doctor --probe`. Expected: session `OK`, no `DynamicsOwinAuth` warning, probe `LIVE`.
   - If a `DynamicsOwinAuth` warning appears: note the real F&O cookie names in the saved file (names only, never values) and update `F_AND_O_AUTH_COOKIE` in `src/d365fo/session.ts`.
   - If the probe says `UNKNOWN` or wrongly `SIGNED-OUT`: note the HTTP status and redirect host it reports.
3. Wait past `D365_SESSION_MAX_AGE_HOURS` (or delete the cookies) and re-run `doctor --probe`. Expected: `SIGNED-OUT`.

## 2. Test cases

4. `node dist/cli/index.js run --local examples/testcases --case TC-SMOKE-LOGIN`. Note whether it passes and whether every step with an `expected` result was reported verified.
5. Run `TC-VENDOR-001` (`--case TC-VENDOR-001`). Note which steps needed retries, which waits were too short or long, and any form quirks (lookups, busy indicators, dialogs).
6. Put the confirmed waits and control names into `docs/d365fo.md` and the knowledge base.

## 3. Newer features

7. Time budgets: set `AGENT_TOOL_TIMEOUT_MS=5000` for one run and confirm a slow call is reported as a timeout in `results.json` (`timeouts`).
8. Trace: with `PW_TRACE=on-failure`, force a failing case and confirm `reports/playwright-output/traces/*.trace` is attached to that result and that a passing case leaves no trace.
9. Verification: confirm a case whose expected result cannot be checked ends `blocked`, not `passed`.
10. Data bag: confirm `record_value` values show in `results.json` and the HTML report.

## 4. Optional

11. Release Planner MCP: run the FastTrack server, set `RELEASE_PLANNER_MCP_URL`, and confirm the three tools are offered. Note: Learn says release plans stop being published in September 2026 (moved to the AI at Work roadmap), so check the server still returns current data.
