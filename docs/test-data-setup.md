# API-side test data setup: design note

Status: design note only, no code. Sources: Microsoft Learn ([Use MCP for finance and operations apps](https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/copilot/copilot-mcp), [Build an agent with Dynamics 365 ERP MCP](https://learn.microsoft.com/dynamics365/fin-ops-core/dev-itpro/copilot/build-agent-mcp)) and FastTrack's Inventory Fulfillment Agent and Warehouse App Task Validation samples. Read 2026-09-30.

## Why

UI tests should check behaviour, not spend most of their steps creating master data. Seeding through an API is faster and more repeatable.

## Option A: Dynamics 365 ERP MCP server (Microsoft)

Per Learn it exposes three tool families over MCP:
- **Data tools** (`data_find_entity_type`, `data_get_entity_metadata`, `data_find_entities`, `data_create_entities`, `data_update_entities`, `data_delete_entities`, `data_find_entities_sql`): OData entity CRUD. Learn says this is more efficient than form tools for standard CRUD.
- **Form tools** (`form_open_menu_item`, `form_set_control_values`, `form_click_control`, `form_save_form`, ...): work through server APIs and return the view model, not a browser.
- **Action tools** (`api_find_actions`, `api_invoke_action`): invoke classes exposed as AI tools.

Behaviour worth knowing: results follow the **signed-in user's security role**; en-US only; no advanced grid filters; some controls unsupported; system-admin forms (users, security roles, feature management) are excluded; unavailable during servicing windows.

Fit: our agent already speaks MCP, so it could register this server (like Release Planner) and use data tools for seeding and verification. Open questions I could not answer from the pages I read: how a non-Copilot-Studio MCP client authenticates (Entra flow, scopes) and the server URL per environment. Read those before building.

## Option B: OData directly

Plain OData calls to data entities (`/data/<Entity>`) with an Entra token. Fully deterministic, no MCP dependency, but needs token handling and entity knowledge in the test case.

## Option C: FastTrack sample pattern

The Warehouse App Task Validation sample seeds bulk sales/purchase data with an X++ project (`.axpp`) and calls the warehouse task web service from C#. It shows seeding outside the UI but is X++/C#, so it is a pattern, not something to reuse in this TypeScript agent.

## Proposed shape (if built)

A `setup` block on a test case, run before step 1, sandbox only and inside the case's legal entity:

```json
"setup": [{ "entity": "CustomersV3", "create": { "CustomerAccount": "TESTC-{timestamp}", "...": "..." }, "saveAs": "customer" }]
```

Created values go into the per-run data bag (`record_value`) so steps can use them, and a matching optional `teardown`. Guardrails needed: refuse on production (existing environment check), block `delete` unless the record was created in this run, redact secrets, and record every write in `results.json`.

## Recommendation

Prototype Option A read-only first (verify a record after a UI action), because that needs no writes and gives the most value for the risk. Add writes only after authentication is understood and the guardrails above exist.
