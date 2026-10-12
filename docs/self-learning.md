# Self-learning

The agent maintains a local, file-backed knowledge base (KB) so useful facts discovered during one run become planning context for the next.

## Learning F&O forms while it works

The most useful learning happens during a run, not at the end of it. `<KB_DIR>/pages.json` (default
`./knowledge/pages.json`) is a map of the F&O forms the agent has worked on:

- **Which form.** Each browser result carries the page URL and title. A form is keyed by its display menu item
  (`mi=` in the URL), else by its caption. Every form visited, however it was reached (search box, a button, a
  link), is added to the pages `d365_open_menu_item` can open by caption.
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

Each entry has a `summary`, `details`, `tags`, an optional `module`, and running counters of successes / failures. When the agent proposes a "learning" that matches an existing summary (case-insensitively), the entry is merged instead of duplicated.

## Known-good paths

Besides the learnings the model proposes, the orchestrator records the browser actions of every passing case and stores them as a `recipe` entry named "Known-good path for test case <id>". It is given to the next run of that case as its starting route and is not mixed into retrieval for other cases. See [Fast navigation and known-good paths](d365fo.md#fast-navigation-and-known-good-paths).

## Retrieval

Before executing a test case the orchestrator queries the KB with the test's title, module, area, tags and step text. Top-K hits are inlined into the user prompt as "Relevant prior learnings" so the model can build on them.

Retrieval is BM25 over summary, details, tags and module. Summaries and tags carry more weight than details. Queries are expanded with F&O synonyms and abbreviations (vendor/supplier, PO/purchase order, LE/legal entity…), and words are stemmed. Entries with a matching tag or in the test's module rank higher, but only when their text matches the query: sharing a module or tag is not relevance on its own. Entries are also biased by their track record. Known-good paths are excluded, because they are handed only to their own test case. Swapping in an embedding store means re-implementing `search` in [`src/knowledge/kb.ts`](../src/knowledge/kb.ts).

## Learning from outcomes

- **Feedback.** After each case, the entries that were retrieved for it are credited when the case passed. They are debited only when the case did not pass for a reason the hints could have caused: a page or record that could not be found (`not_found`, unless every step that stopped the case reported a missing permission), a `timeout`, the agent getting stuck (`agent`), or an expected result that was not checked (`unverified`). A likely product defect (`assertion`), sign-in, budget, guardrail and tooling problems, and missing data do not count against them. Entries that keep misleading the agent sink in the ranking, and `learn --prune` removes them.
- **Stale paths.** A known-good path is judged by the same rule as the hints. When the case does not pass twice in a row for a reason the route could have caused (for example a page or button that is no longer found after a UI change, a timeout, or the agent getting stuck), the path is no longer offered. The case then explores again and records a fresh path when it passes. A likely product defect (`assertion`) does not count against the path.
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

Delete `knowledge/kb.json`. The agent will start with an empty KB on the next run.

## Privacy

No customer data should be written into learnings by the agent — the system prompt instructs it to keep entries generic. Review `kb.json` before committing it if you plan to share the KB.
