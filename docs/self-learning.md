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

Before executing a test case the orchestrator queries the KB with the test's title, module, and tags. Top-K hits are inlined into the user prompt as "Relevant prior learnings" so the model can build on them.

Retrieval is a keyword score with a mild success/failure bias — good enough for MVP and easy to reason about. Swapping in an embedding-based store is a well-defined future change (implement `retrieve` differently in [`src/knowledge/kb.ts`](../src/knowledge/kb.ts)).

## Inspecting / exporting

```bash
node dist/cli/index.js learn                 # dump to stdout
node dist/cli/index.js learn --output kb.json
```

## Resetting

Delete `knowledge/kb.json`. The agent will start with an empty KB on the next run.

## Privacy

No customer data should be written into learnings by the agent — the system prompt instructs it to keep entries generic. Review `kb.json` before committing it if you plan to share the KB.
