# Self-learning

The agent maintains a local, file-backed knowledge base (KB) so useful facts discovered during one run become planning context for the next.

## Learning F&O forms while it works

The most useful learning happens during a run, not at the end of it. `<KB_DIR>/pages.json` (default
`./knowledge/pages.json`) is a map of the F&O forms the agent has worked on:

- **Which form.** Each browser result carries the page URL and title. A form is keyed by its display menu item
  (`mi=` in the URL), else by its caption. Every form visited with a menu item in its URL, however it was reached
  (search box, a button, a link), is added to the pages `d365_open_menu_item` can open by caption.
- **Which controls.** After each successful click, entry, selection or hover, Playwright reports the locator the
  action resolved to. With F&O's `data-dyn-controlname` set as the test-id attribute that is usually
  `getByTestId('<AOT control name>')`, otherwise a role and name such as `getByRole('textbox', { name: 'Vendor
  account' })`. It is stored under the form with the element description the model used and a success count.
  Snapshot refs and position-based locators (`nth`, `first`) are never stored, nor are typed values.
- **When it is used.** The first time the browser lands on a known form in an attempt, the tool result lists up to
  15 learned controls with their targets. The model passes a target straight to `browser_click` / `browser_type`, so
  a form it has seen before needs no full snapshot. A target that no longer matches is retried once after F&O
  finishes loading, counted as a failure, and dropped once it fails more often than it worked.
- **Notes.** `d365_page_note` saves a short fact about the current form (a field on a collapsed FastTab, a dialog
  after Save); it is shown with the form's controls from then on.

The map is updated in memory as the run goes (later cases in the same run benefit straight away) and written at the
end of each attempt and after each note. Turn it off with `AGENT_LEARN_PAGES=false`. The settings app's chat tools
show it with `list_learned_pages`. Delete the file to start over; edit it to correct a control. It holds no data
values, but captions and control labels come from your environment, so treat it like the rest of `knowledge/`.

## Storage

Location: `${KB_DIR}/kb.json` (the form map above is `${KB_DIR}/pages.json`) (default `./knowledge/kb.json`). It is a plain JSON file, easy to inspect and diff. There is no external database.

## Entry kinds

| Kind | Purpose |
| --- | --- |
| `selector` | A resolved accessibility ref or semantic locator that worked for a specific UI element. |
| `recipe` | A short sequence of steps that reliably accomplishes a workflow (e.g. "create vendor"). |
| `remediation` | An error signature paired with a fix (retry, alt navigation, refresh). |
| `doc` | A relevant snippet retrieved from Microsoft Learn, with citation. |

Each entry has a `summary`, `details`, `tags`, an optional `module`, and running counters of successes / failures. The model proposes learnings in the `learnings` of `finish_test`. One that matches an existing entry of the same kind and summary (case-insensitively) is merged into it instead of duplicated.

## Known-good paths

Besides the learnings the model proposes, the orchestrator records the browser actions of every passing case and stores them as a `recipe` entry named "Known-good path for test case <id>". It is given to the next run of that case as its starting route and is not mixed into retrieval for other cases. See [Fast navigation and known-good paths](d365fo.md#fast-navigation-and-known-good-paths).

## Replay without the AI

A passing case is also recorded as the Playwright code its browser actions ran (Playwright MCP reports it with every
action), filed under the step it belonged to, together with the checks the agent made with the `browser_verify_*`
tools. Recordings are kept in `<KB_DIR>/replays.json`, one per case.

On the next run of the case, the recording is replayed step by step before the AI is asked, with a wait for F&O's
"Please wait" overlay after every action. A replay that gets through every step and check is the result: no model
calls, and the report says it was replayed. When a replay fails, the AI runs the case as usual and is told where the
replay stopped; if it passes, its run replaces the recording.

A case is only replayed when its recording can stand in for the AI:

- every step was reported in the recorded run, and every step with an expected result has a recorded check (an
  expected result the agent verified by reading a snapshot cannot be replayed, so such a case always runs with the AI);
- the test case has not changed since it was recorded;
- the recording contains only plain locator actions, navigation and checks. Native dialogs, other tabs and drag and
  drop are not replayed, and a recording where a secret appeared is not kept for replay;
- every address in it passes the same navigation guardrails as a model request (another environment or legal entity
  is refused), and it has not failed twice in a row.

Replays run through Playwright MCP's run-code tool, which the model is never offered, and only code that matches a
strict pattern of locator calls with literal values is run, so an edited `replays.json` cannot run anything else.
Dry runs never replay. Turn replay off with `AGENT_REPLAY=false`.

Values are replayed as they were typed: a case that creates a record with a fixed id may fail on replay because the
record exists, and then runs with the AI.

### Export as Playwright tests

`d365fo-agent export-tests --out playwright-tests` writes each recording as a `<case id>.spec.ts` with a
`playwright.config.ts` that uses F&O's control names (`data-dyn-controlname`) as test ids and the saved sign-in
(override with `D365_STORAGE_STATE`). Run them with `npm install && npx playwright test` in that folder, for example
in CI, without an AI model. `--case` limits the export to some cases; `--local` names the folder of local test cases
so each `test.step` shows the step's action.

## Retrieval

Before executing a test case the orchestrator queries the KB with the test's title, module, area, tags and step text. Top-K hits are inlined into the user prompt as "Relevant prior learnings" so the model can build on them.

Retrieval is BM25 over summary, details and tags; the summary counts twice. Queries are expanded with F&O synonyms and abbreviations (vendor/supplier, PO/purchase order, LE/legal entity…), and words are stemmed. Entries with a matching tag or in the test's module rank higher, but only when their text matches the query: sharing a module or tag is not relevance on its own. Entries are also biased by their track record. Known-good paths are excluded, because they are handed only to their own test case. During a run the model can also query the KB itself with the `kb_search` tool. The ranking is implemented in `search` in [`src/knowledge/kb.ts`](../src/knowledge/kb.ts).

## Learning from outcomes

- **Feedback.** After each case, the entries that were retrieved for it are credited when the case passed. They are debited only when the case did not pass for a reason the hints could have caused: a page or record that could not be found (`not_found`, unless every step that stopped the case reported a missing permission), a `timeout`, the agent getting stuck (`agent`), or an expected result that was not checked (`unverified`). A likely product defect (`assertion`), sign-in, budget, guardrail and tooling problems, and missing data do not count against them. Entries that keep misleading the agent sink in the ranking, and `learn --prune` removes them.
- **Stale paths.** A known-good path is judged by the same rule as the hints, except that any step reported as not found counts against it. When the case does not pass twice in a row for a reason the route could have caused (for example a page or button that is no longer found after a UI change, a timeout, or the agent getting stuck), the path is no longer offered. The case then explores again and records a fresh path when it passes. A likely product defect (`assertion`) does not count against the path.
- **Reflexion on retries.** When a case is retried, the prompt says what happened last time: the outcome and reason, which steps passed (their data may already exist), which failed or were blocked and why, which calls the guardrails refused, and which calls timed out. It also tells the agent to take a fresh snapshot and try a different approach instead of repeating the failed one.
- **Self-healing.** When a case fails and then passes on a retry, the agent saves a `remediation` entry tagged `self-healed`: the step that broke, why, and the actions that worked. It is retrieved the next time a similar case runs. Nothing is saved from cases that passed first time.
- **Failure triage.** Each result that did not pass is classified (`assertion`, `sign_in`, `not_found`, `guardrail`, `timeout`, `budget`, `unverified`, `agent`, `infrastructure`, `blocked`) from the step causes, guardrail blocks, timeouts and limits. The category and a hint for what to do appear in the run log, the HTML report, `results.json` and as the `type` of the JUnit `<failure>` (failed) or `<error>` (blocked).

Dry runs teach nothing: no feedback, no known-good path, no self-healing entry, and the learnings the model proposes at the end of a dry run are discarded.

## Inspecting and maintaining

```bash
node dist/cli/index.js learn                          # dump to stdout
node dist/cli/index.js learn --output kb.json
node dist/cli/index.js learn --stats                  # counts by kind/module, stale known-good paths
node dist/cli/index.js learn --search "create supplier" --module "Accounts payable" --tag smoke   # what a run would retrieve (top 5), with scores
node dist/cli/index.js learn --search "create supplier" --top 20                              # look further down the ranking
node dist/cli/index.js learn --prune                  # drop unreliable entries and stale paths
node dist/cli/index.js learn --prune --min-failures 5 --max-age-days 90
```

`--prune` removes entries that failed at least `--min-failures` times (default 3) and more often than they succeeded, plus stale known-good paths. With `--max-age-days`, it also removes entries that no passing run has confirmed and that have not been updated in that many days.

The file is saved atomically. Before each save, what another process wrote in the meantime (a second run, the settings app, `learn --prune`) is merged in: entries it added are kept, entries it removed stay removed, and for an entry both changed the more recently updated one wins. If `kb.json` is unreadable it is moved aside as `kb.json.corrupt-<time>` and the agent starts with an empty KB instead of failing the run. If only some entries are unusable (no valid kind or summary), the file is first copied to `kb.json.invalid-<time>` and those entries are dropped. Both cases print a warning.

## Resetting

Delete `knowledge/kb.json` (`<KB_DIR>/kb.json`). The agent will start with an empty KB on the next run. The form map (`pages.json`) and the replay recordings (`replays.json`) in the same folder are separate files; delete them to reset those too.

## Privacy

The prompt asks for concise, reusable facts about F&O selectors and workflows, and `d365_page_note` for generic facts without data values, names or secrets. The configured username, password, API keys and tokens, and token-like strings (JWTs, bearer tokens), are replaced with `***` before a learning is stored. Nothing else filters customer data out, so review `kb.json` before committing it if you plan to share the KB.
