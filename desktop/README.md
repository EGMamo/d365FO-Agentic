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

The desktop stages the built Node service, web pages, examples, shell, and pinned Playwright MCP. It bundles uv, which installs Python 3.11 and pinned slim Open WebUI 0.11.4 on first launch. Internet access is required on first launch; no Docker is needed. Existing conversations remain in the same Open WebUI data folder. The first browser run may also download Chromium.

The settings service provides the local model/tool bridges. Open WebUI receives a local token, not the provider key. There is no alternate built-in chat or separate model picker. Settings pages remain usable while Chat starts or if it fails. Restart to retry a failed Chat startup.

Settings are in the usual private `d365fo-agent` user folder (override `D365FO_AGENT_HOME`). Test files and reports are under `Documents/D365FO Agent` (override `D365FO_WORKSPACE`). Open WebUI/Python/conversations remain in Electron's user-data folder. Upgrades back up configuration before migration and retain existing environment IDs/report paths and legacy model files.

## Desktop checks and targets

The `desktop` workflow builds macOS Apple Silicon and Windows x64 installers and verifies the bundled Playwright command starts under Electron. The self-hosted `desktop-e2e` workflow preserves Windows ARM coverage, with x64 emulation optional. See [../docs/windows-arm-runner.md](../docs/windows-arm-runner.md).

`desktop/e2e/run.mjs` starts an installed/unpacked app, attaches through Chromium debugging, exercises the four destinations, saves environment settings through the actual form, and reloads them. With configured credentials it checks the shared AI connection and runs a sample diagnostic, verifying that the requested case produced structured results. It does not claim the diagnostic proves live sign-in or a business pass. Screenshots/logs are uploaded without the private profile directory.

Supported checks need the actual target machine. Linux has a development AppImage target but is not a published/tested installer target. No new platforms are added by this change.

## Signing and updates

Installers remain unsigned. macOS/Windows may require the existing manual trust steps. There is no automatic update feed: install a new version over the old one. Existing signing configuration and supported targets are unchanged.

## Open WebUI license

Open WebUI has its own license, including branding requirements. The application retains its upstream branding and notices. Do not remove or replace them without satisfying the license. See <https://docs.openwebui.com/license/>.

Some upstream admin settings may remain visible in the single-user local configuration. Feature reduction uses supported configuration, not an Open WebUI fork. See [../docs/openwebui.md](../docs/openwebui.md).
