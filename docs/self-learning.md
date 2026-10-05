# Self-learning

The agent maintains a local, file-backed knowledge base (KB) so useful facts discovered during one run become planning context for the next.

## Storage

Location: `${KB_DIR}/kb.json` (default `./knowledge/kb.json`). It is a plain JSON file, easy to inspect and diff. There is no external database.

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
