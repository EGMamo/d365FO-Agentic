# Standalone recording and replay

Agent runs can save a standalone Playwright project under `<REPORT_DIR>/replay` (or `AGENT_REPLAY_DIR`). Each environment profile therefore keeps its own tests, data and replay results. Recording defaults to on; set `AGENT_RECORD_TESTS=false` to disable it.

## What is recorded

- Only code in Playwright MCP's **Ran Playwright code** result from a successful, allowlisted browser call. This includes assertions emitted by the `browser_verify_*` tools.
- `begin_step` associates calls with steps. If the model omits it, the first unreported step is used.
- `capture_value` can read a new non-secret document number from an exact D365 `data-dyn-controlname`. The app constructs `page.getByTestId(...).inputValue()` or `.textContent()` itself and stores the bounded/redacted value. Model-provided JavaScript, arbitrary code tools, credential entry, secret-shaped captures, hidden tools, failed calls and dry-run pseudo-actions are never recorded.
- Non-secret parameter rows are written as data. A recording with secret-shaped parameter names or values is refused rather than written to spec/data artifacts. Recorded absolute F&O URLs become environment-relative, D365 busy waits are added, and ADO IDs/URLs become test annotations.

Failed or incomplete recordings are saved as `test.fixme`; interrupted runs and dry runs do not write a spec. A passing recording is not replaced by a later failed row. Generated config/helpers/package files are created only when missing, so user edits to them are preserved. Generated spec and data paths appear in case artifacts and `results.json`.

## Replay

Build the app, then use the active profile (or `--profile`):

```bash
node dist/cli/index.js replay
node dist/cli/index.js replay 'tests/TC-1234-*.spec.ts' --grep 'row 2' --headed
# Explicitly publish only the fresh results of this invocation:
node dist/cli/index.js replay --upload --plan 1234
```

Replay starts the pinned `@playwright/test` runner directly, with no model and no MCP. It resolves the replay project's install first and otherwise the app's bundled dependency. The active profile supplies the F&O URL, saved storage state and browser selection. The child gets a minimal environment without LLM, ADO or D365 password/token settings. Paths and globs are confined to the replay project. Ctrl+C/SIGTERM cancels the run.

Old JSON/JUnit results are deleted before launch, and upload requires fresh results with ADO case IDs from that invocation. Failed test outcomes can still be uploaded; an interrupted or unsuccessful launch cannot upload stale data. Replay is intentionally a CLI operation, not a Chat/model tool. Chat cannot start it or override its filters/publishing choice.

For a generated standalone project, ordinary manual execution also works (a lockfile is not required or assumed):

```bash
cd <REPORT_DIR>/replay
npm install
npx playwright test
```

The generated config writes HTML, JUnit and JSON reports and retains traces, screenshots and video on failure. `@playwright/test` is pinned exactly to the app's Playwright runtime, `1.64.0-alpha-1789764292000`; `@playwright/mcp` remains `0.0.82`.

## Shared steps and parameter iterations

Nested ADO `compref` shared steps are expanded with their action paths and shared-step IDs. Direct dependencies are read in batches of at most 200 and cached; nested dependencies use the same cache. An unreadable or recursive dependency creates an explicit case problem and a preflight blocked result **before any model or browser execution**. The remaining steps are never presented as a complete test.

All local and shared parameter rows are retained. The default remains row 1. Use `run --all-iterations`, or **All data rows** in Tests, to execute every row in deterministic order. Each row has its own substituted steps, result, logs/artifacts and outcome; case IDs stay stable. Values made by a row are not shared with another row, and failed rows never supply carry values. Direct-run confirmation shows the number of cases and iterations. Chat cannot enable all iterations or alter suite/publishing choices.

Publishing creates one ADO case result with per-row `iterationDetails`, `actionResults`/`actionPath`, and a Failed > Blocked > NotExecuted > Passed worst-outcome rollup. If the service rejects those details, the client retries with the case-level rollup. Artifact attachment and explicit upload confirmation are unchanged. The existing REST publishing flow retains its current first-test-point/service mapping behavior; this stage does **not** claim full multi-configuration/test-point coverage.

## Limitations and validation

Recordings are code generated from a particular run, not a guarantee that selectors or business data remain valid. Review `test.fixme` drafts and environment-specific values before activating them. Saved storage state is sensitive and should be protected like a sign-in. Do not capture secrets intentionally; the tool's checks are a backstop, not a classification system for every possible secret.

The test suite uses generated-spec TypeScript compilation and mocked/local replay and ADO integrations. No live D365 or Azure DevOps validation is claimed by this stage.
