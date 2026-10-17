# Learned forms and controls

The runner keeps one small map at `<KB_DIR>/pages.json` (default `knowledge/pages.json`). It stores F&O form captions/menu items, stable control locators, basic success/failure counts, and short form notes. It does not store typed business values.

The map helps open forms directly and reuse `data-dyn-controlname` targets. It is offered as untrusted hints: test steps, current page evidence, and guardrails still govern execution. Unreliable controls are dropped. Disable it with `AGENT_LEARN_PAGES=false` or remove the file to reset it.

General knowledge-base retrieval, recipes, feedback ranking, pruning, retry learning, recorded-code replay, and Playwright export have been removed. Legacy `kb.json` and `replays.json` files are left untouched for rollback and are no longer read. Values recorded during a case appear in that case's report and remain within the case.

Treat the form map and reports as environment data. Do not commit or share them indiscriminately.
