# D365FO Agent desktop

One Electron window with four destinations: **Chat** (Open WebUI), **Tests**, **Results**, and **Settings**. One Claude connection serves chat and test execution. Environments contain F&O and optional Azure DevOps settings; Results includes previous runs.

## Building

```bash
npm ci && npm run build        # repository root
cd desktop
npm ci
npm run dist                  # installer for the current target
# or:
npm start
```

The desktop stages the built Node service, web pages, examples, shell, and pinned Playwright MCP. Staging checks the committed `runtime/package.json` against the application dependencies, installs with `npm ci`, audits the actual application tree, and includes a CycloneDX dependency inventory. Run `npm run lock:runtime` and commit the runtime manifest and lockfile whenever the application dependencies or Playwright pin change.

The app bundles uv, which installs Python 3.11 and pinned slim Open WebUI 0.11.4 on first launch. Internet access is required on first launch; no Docker is needed. Browser sign-in uses the bundled Playwright CLI under Electron, without a system Node/npm installation. Existing conversations remain in the same Open WebUI data folder. The first browser run may also download Chromium.

The settings service provides the local model/tool bridges. Open WebUI receives a local token, not the provider key. Chat access uses an app-managed trusted-header session supplied by Electron only to its own chat view at the exact local origin. Live runs and uploads requested by chat require a native desktop confirmation showing the target. There is no alternate built-in chat or separate model picker. Settings pages remain usable while Chat starts or if it fails. Restart to retry a failed Chat startup.

Settings are in the usual private `d365fo-agent` user folder (override `D365FO_AGENT_HOME`). Test files and reports are under `Documents/D365FO Agent` (override `D365FO_WORKSPACE`). Open WebUI/Python/conversations remain in Electron's user-data folder. Upgrades back up configuration before migration and retain existing environment IDs/report paths and legacy model files.

## Desktop checks and targets

The `desktop` workflow runs on relevant main pushes and pull requests, tags, and manual dispatches. It builds macOS Apple Silicon and Windows x64 installers, verifies both bundled Playwright commands under Electron, and exercises the packaged app's Settings persistence and page navigation on the build host. The self-hosted `desktop-e2e` workflow preserves Windows ARM coverage, with x64 emulation optional. See [../docs/windows-arm-runner.md](../docs/windows-arm-runner.md).

`npm run smoke` exercises the packaged app on a native build host. `desktop/e2e/run.mjs` starts an installed/unpacked app, attaches through Chromium debugging, changes a legal entity to a distinct sentinel through the actual form, reloads it, and restores the configured entity. Its settings, workspace, and desktop/Python data are isolated under the evidence folder. With configured credentials it checks the shared AI connection and runs a sample diagnostic, verifying that the requested case produced structured results. It does not claim the diagnostic proves live sign-in or a business pass. Screenshots/logs are uploaded without the private data folders.

Supported checks need the actual target machine. Linux has a development AppImage target but is not a published/tested installer target. No new platforms are added by this change.

## Signing and updates

Ordinary `npm run dist` and main/PR builds produce development installers. Tag builds use `npm run dist:release`, which refuses to proceed without signing credentials and requires code signing; macOS releases also require notarization. Configure `MACOS_CSC_LINK`/`MACOS_CSC_KEY_PASSWORD` and `WINDOWS_CSC_LINK`/`WINDOWS_CSC_KEY_PASSWORD` in repository secrets. macOS notarization additionally uses `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Missing credentials are a failed release gate, never an unsigned production fallback.

There is no automatic update feed. Keep the previous signed installer, close the app, and install the new signed version over it. Validate an upgrade and rollback with a copy of existing settings/conversation data before distribution. Python runtime upgrades keep the previous working runtime until the replacement installs successfully. Release approval also requires the real sandbox checks in [../docs/sandbox-checklist.md](../docs/sandbox-checklist.md); passing a diagnostic smoke test alone is insufficient.

## Open WebUI license

Open WebUI has its own license, including branding requirements. The application retains its upstream branding and notices. Do not remove or replace them without satisfying the license. See <https://docs.openwebui.com/license/>.

Some upstream admin settings may remain visible to the authenticated local desktop user. Feature reduction uses supported configuration and a small app-theme stylesheet, not an Open WebUI fork. See [../docs/openwebui.md](../docs/openwebui.md).
