# RSAT and Azure DevOps Test Plans: design note

Status: design note only, no code. Sources are Microsoft Learn pages quoted below (read 2026-09-30). FastTrack has no RSAT content, so nothing here comes from it.

## Key finding: RSAT is being retired

Learn marks the [Regression suite automation tool](https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/perf-test/rsat/rsat-overview) "for deprecation"; it "won't be supported after May 15, 2027". Teams using RSAT will need an alternative, which is a reason to support their existing Azure DevOps test cases well, but not to build around RSAT files.

## How RSAT uses Azure DevOps (per Learn)

- Test cases live in a **test plan** and **test suites** in Azure DevOps; RSAT loads one suite at a time ([Use RSAT](https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/perf-test/rsat/rsat-run)).
- Each test case needs a **Task recorder recording** (`recording.xml`, or named after the test case) attached to it. RSAT generates `_Base.cs/.xml/.dll` execution files and an **Excel parameter file** with `General`, `MessageValidation` and `TestCaseSteps` tabs.
- Parameters are decoupled from steps: inputs and validations sit next to each recorded step in `TestCaseSteps`; validations support operators such as `=` and `>` ([Validate expected values](https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/perf-test/rsat/rsat-validate-expected), [tutorial](https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/perf-test/rsat/rsat-tutorial)).
- The `General` tab can set a **Test User** (run under that user's roles) and a **company** (legal entity), and a pause; test cases can be chained through saved variables and derived from one recording with different data ([chain](https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/perf-test/rsat/rsat-chain-test-cases), [derived](https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/perf-test/rsat/rsat-derived-test-cases)).
- Results are published to an Azure DevOps test run, with duration and per-step response times (`BaseTime.xml`) attached.

## What our agent does today

Reads test cases and steps (`Microsoft.VSTS.TCM.Steps`) from a plan and suite, executes them through the UI, and publishes a run with attachments (`src/devops/client.ts`, `docs/azure-devops.md`). It does **not** read recordings, Excel parameter files or RSAT variables.

## Mapping ideas

| RSAT concept | Agent equivalent | Gap |
|---|---|---|
| Test suite in a plan | `--plan` / `--suite` | none |
| Recorded steps | Test-case steps in plain text | Recordings are not read; steps must be written in the test case |
| Excel `TestCaseSteps` inputs | Values written in the step text | No structured parameters |
| Validation (`=`, `>`) | `expected` text checked against a snapshot (item 6, verified flag) | Free text, no operators |
| `Test User` / company | `legalEntity` on the case; the signed-in account decides roles | No per-case test user |
| Chained variables | `record_value` / `recall_values` within one case (item 7) | Not across cases |
| Response times | Step duration only | No per-step timing |

## Recommendation

1. Do not import recordings or `.dll` files (RSAT-specific and going away).
2. If parameters are wanted, read the Excel `TestCaseSteps` tab as a table of `step -> input/expected` and merge it into the step text. First step to prototype: read one parameter file with a spreadsheet reader and print the pairs. Needs a real RSAT-authored file to check the layout; none was available here.
3. Add an optional `testUser` field to test cases and warn when the signed-in account differs (roles decide what the agent can do).
4. Cross-case variable passing is only worth adding if users actually chain cases.
