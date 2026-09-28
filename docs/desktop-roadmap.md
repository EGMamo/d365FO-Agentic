# Desktop transition roadmap

This project now keeps execution logic in a reusable core engine (`src/core/runner.ts`) so CLI remains an adapter and a desktop shell can reuse the same run semantics.

## Layering target

- **Core Engine**: orchestration, reloop policy, providers, reporting.
- **Adapters**: MCP, Azure DevOps, filesystem.
- **Interfaces**: CLI (current) and desktop shell (next).

## Desktop scope

A desktop shell (Electron or Tauri) should:

1. Configure environments and provider settings.
2. Discover test cases (local and Azure DevOps).
3. Run tests with reloop controls.
4. Stream live run logs and step outcomes.
5. View artifacts and generated reports.
6. Store credentials in OS keychain (not plaintext `.env`).

## Migration phases

1. **Completed foundation**: core run engine extracted and retry-aware reporting added.
2. **Desktop interface**: implement shell UI that invokes core engine APIs.
3. **Hardening**: add secure secret storage, run controls, and packaging.
