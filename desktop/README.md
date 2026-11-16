# D365FO Agent desktop

One Electron window with four destinations: **Chat**, **Tests**, **Results**, and **Settings**. They are pages of one app-owned local web application, backed by one Node service. One Claude connection serves Chat and test execution. Environments contain F&O and optional Azure DevOps settings; Results includes previous runs.

## Building

```bash
npm ci && npm run build        # repository root
cd desktop
npm ci
npm run dist                  # installer for the current target
# or:
npm start
```

The desktop stages the built Node service, web pages, examples, shell, and pinned Playwright MCP. Staging checks the committed `runtime/package.json` against application dependencies, installs with `npm ci`, audits the application tree, and includes a CycloneDX dependency inventory. Run `npm run lock:runtime` and commit the runtime manifest and lockfile whenever application dependencies or the Playwright pin change.

The packaged desktop needs **no Python, uv, Open WebUI, Docker, or first-launch Chat download**. The first browser test run may still download the Playwright browser. Browser sign-in uses the bundled Playwright CLI under Electron, without a system Node/npm installation. Node's built-in SQLite reader imports legacy Open WebUI conversations, including committed WAL data, without an extra dependency or service.

The settings service owns model credentials, application operations, Chat persistence, and run processes. Live runs and uploads requested by Chat require a native desktop confirmation showing the actual target. Chat and the page actions share the same executor and reservation policy. Open WebUI conversations are imported once from its existing SQLite database without modifying or starting the legacy runtime; see [../docs/chat.md](../docs/chat.md).

Settings are in the usual private `d365fo-agent` user folder (override `D365FO_AGENT_HOME`). Test files and reports are under `Documents/D365FO Agent` (override `D365FO_WORKSPACE`). App-owned conversations are under `chats/` in the agent home. Upgrades back up configuration before migration and retain existing environment IDs/report paths and legacy model files. See [../docs/architecture.md](../docs/architecture.md) for module ownership and extension points.

## Desktop checks and targets

The `desktop` workflow runs on relevant main pushes and pull requests, tags, and manual dispatches. It builds macOS Apple Silicon and Windows x64 installers, verifies both bundled Playwright commands under Electron, and exercises the packaged app's conversation persistence, Settings persistence, and page navigation on the build host. The self-hosted `desktop-e2e` workflow preserves Windows ARM coverage, with x64 emulation optional. See [../docs/windows-arm-runner.md](../docs/windows-arm-runner.md).

`npm run smoke` exercises the packaged app on a native build host. `desktop/e2e/run.mjs` starts an installed/unpacked app, attaches through Chromium debugging, creates/renames/reloads a Chat conversation, changes a legal entity to a distinct sentinel through the actual form, reloads it, and restores the configured entity. Its settings, workspace, and desktop data are isolated under the evidence folder. With configured credentials it checks the shared AI connection and runs a sample diagnostic, verifying that the requested case produced structured results. `E2E_MODEL=true` additionally sends a real Chat request when `E2E_ANTHROPIC_API_KEY` is supplied. It does not claim the diagnostic proves live sign-in or a business pass. Screenshots/logs are uploaded without the private data folders.

Supported checks need the actual target machine. Linux has a development AppImage target but is not a published/tested installer target. No new platforms are added by this change.

## Release and upgrade

Signed tags need the credentials checked by `scripts/check-release.mjs`: a macOS Developer ID plus notarization settings, or a Windows code-signing certificate. Development builds are unsigned where necessary. Do not create a distribution tag from an unverified installation.

There is no automatic update feed. Keep the previous signed installer, close the app, and install the new signed version over it. Validate an upgrade and rollback with a copy of existing settings/conversation data before distribution. Release approval also requires the real sandbox checks in [../docs/sandbox-checklist.md](../docs/sandbox-checklist.md); passing a diagnostic smoke test alone is insufficient.

## Historical chat files

No previous chat runtime is bundled or executed, so its frontend branding and runtime are no longer part of the shipped application. Historical files are not read, imported, or deleted automatically; they stay in their own folders until the user removes them through normal application-data administration. Follow any retained historical license if redistributing such artifacts separately.
