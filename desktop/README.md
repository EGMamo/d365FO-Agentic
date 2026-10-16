# D365FO Agent desktop app

An installer for people who should not need a terminal. It opens one window with a strip of icons down the left side: **Chat** (Open WebUI,
already connected to the D365FO test runner tools), then **Profiles**, **AI models**, **Test cases**, **Run**, **Results** and
**History** from the settings app (Ctrl/Cmd+1 to 7, also in the **App** menu). The Chat page has a bar above the chat to pick the chat AI model, shared by every profile, and a **New chat** button. The profile in use is shown at the bottom of the strip; click it to
switch. Switching is off while a run is in progress. No Docker, Node.js or Python needs to be installed.

## What happens on a user's computer

1. They install `D365FO Agent-<version>-arm64.dmg` (macOS, Apple Silicon only: M1 or newer, no Intel build) or `D365FO Agent Setup <version>.exe` (Windows, x64) and open it.
2. The app starts the settings app and its tool server on `127.0.0.1` inside the app; the agent's own commands run on Electron's Node runtime (`ELECTRON_RUN_AS_NODE`).
3. **First start only:** the bundled [uv](https://github.com/astral-sh/uv) downloads a standalone Python 3.11 and
   installs the pinned Open WebUI (`OPENWEBUI_VERSION` in `src/desktop/openwebui.ts`) into the app's data folder. This needs internet access
   to PyPI and GitHub (python-build-standalone), takes about 2 to 3 minutes on a fast connection and about 0.8 GB on disk (measured on Linux; macOS and Windows not measured). Open WebUI runs in its own slim mode: the install leaves out its local AI stack (PyTorch and its GPU libraries, embeddings, speech and image recognition, the bundled vector database) and the cloud storage clients, which took the Linux install from 7.1 GB to 0.7 GB. The list is `EXCLUDED_PACKAGES` in `src/desktop/openwebui.ts`. Chats use a hosted or local model through a connection, so none of that is needed; uploading documents for search and local voice input do not work. Features a test chat does not use are switched off with Open WebUI's own settings (`DISABLED_FEATURES` in the same file): sharing, channels, notes, folders, calendar, automations, web search, image and code tools, memories, cloud drives, the Ollama API, direct connections and extra model calls. A splash screen
   shows progress. The settings app pages already work while this runs.
4. Open WebUI starts (20 to 40 seconds; the window shows progress meanwhile, and the app gives up after 4 minutes) on a free loopback port without a sign-in screen (one local user), with the tool server, starter
   prompts and, when the chat AI model speaks an OpenAI-style API (OpenAI, Anthropic at its default address, GitHub Models, or an
   OpenAI-compatible server such as Ollama), that model as its chat model. With GitHub Copilot, Azure OpenAI or a custom Claude API URL, add a model under Admin Panel >
   Settings > Connections. The chat AI model is one setting for every profile: pick it in the bar above the chat, and the app writes it to Open WebUI's first connection (on every start and on every change). The tool server's address and key are refreshed on every start.
5. The first test run downloads the Playwright browser (about 300 MB), using the Playwright MCP bundled in the app.

If Open WebUI cannot be installed or started, the app says so and the **Chat** button opens the settings app's own **Chat**
tab instead, which talks to the chat AI model directly and needs no Open WebUI.

Data locations: test cases, reports and the knowledge base in `Documents/D365FO Agent` (or the folder in `D365FO_WORKSPACE`; the
sample test cases are copied there when it has no `examples` folder, and **App > Open the workspace folder** opens it); profiles in the usual agent folder (see the main README); Open WebUI, its Python and its chats
in the app's data folder (`~/Library/Application Support/D365FO Agent`, `%APPDATA%\D365FO Agent`).

## Building

```bash
npm ci && npm run build        # in the project folder
cd desktop
npm ci
npm run dist                   # installer for this OS in desktop/release/
npm start                      # or run it without packaging (uses `uv` from PATH, or D365FO_UV)
```

`npm run dist` stages the built agent (`dist`, `web`, `examples`) into `desktop/app` with the pinned `@playwright/mcp` (`bundle.playwrightMcp` in
`package.json`), downloads the pinned uv (`bundle.uv`) for this computer's OS into `desktop/resources/uv`, and runs electron-builder.
`electron-builder.yml` builds a macOS `.dmg` for arm64 and a Windows NSIS installer for x64 (it also has a Linux AppImage target,
which is not built or tested in CI).

GitHub Actions (`.github/workflows/desktop.yml`) builds the macOS and Windows installers on pull requests that change
`desktop/`, `src/desktop/`, `src/runtime/` or the workflow, on `v*` tags and on demand. It also checks that the bundled Playwright MCP
starts under the app's Electron. Download the installers from the run's artifacts (`installer-macos-latest`,
`installer-windows-latest`).

## End-to-end check on Windows ARM

`.github/workflows/desktop-e2e.yml` runs on a self-hosted Windows ARM computer (labels `self-hosted`, `windows`, `arm64`;
setup in [docs/windows-arm-runner.md](../docs/windows-arm-runner.md)). It builds a Windows installer for arm64 (or x64,
picked when started by hand: `electron-builder --win nsis --arm64` with `node scripts/fetch-uv.mjs win-arm64`), installs it
silently into a temporary folder, and runs `e2e/run.mjs`. That script starts the installed app with Chromium's remote
debugging port, attaches with the Playwright bundled in the app, and checks, as a user would: the side strip and settings
app load, the sample test cases are in the workspace, a profile can be created and selected, the agent's own commands run on
the app's Electron (the profile check), every page opens from the strip, and Open WebUI installs and starts in the Chat
page. With the `E2E_*` repository secrets set it also runs the sample login case against F&O in dry-run mode. Profiles and
the workspace go to fresh folders, so the computer's own profiles are untouched; Open WebUI uses the app's usual data folder,
so it installs on the first run only (or every run started with **fresh**). Screenshots, the app's log and a summary are kept
as the run's `desktop-e2e-win-<arch>` artifact. The installer built here is the arm64 one only this workflow makes;
`desktop.yml` still ships x64.

The same script works against any unpacked build, for example on Linux:
`npx electron-builder --linux dir`, then
`E2E_APP=release/linux-unpacked/d365fo-agent E2E_OUT=/tmp/e2e E2E_APP_ARGS=--no-sandbox xvfb-run -a node e2e/run.mjs`.

## Signing

The installers are unsigned (the workflow sets `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`), so macOS Gatekeeper and Windows SmartScreen warn on first open (macOS: right-click >
Open; Windows: More info > Run anyway).

## Open WebUI licence

Open WebUI from v0.6.6 is under the Open WebUI License: BSD-3 plus a branding clause. The app runs Open WebUI
unmodified, installed from PyPI on the user's computer, and does not remove or change its name or logo, which the
licence allows. Do not hide or replace Open WebUI's branding in the chat window (for example with `WEBUI_NAME` or
custom CSS) without an Open WebUI enterprise licence, unless the deployment stays under 50 users in any 30-day period.
See <https://docs.openwebui.com/license/>.

## Limitations

- No auto-update (`publish: null` in `electron-builder.yml`): install a newer version over the old one.
- The first start needs internet access to install Python and Open WebUI; there is no offline installer.
- Session sign-in (`session-login`) still runs through `npx playwright`, which needs Node.js; use a test account and password in the
  profile, or save the session from a computer with Node.js.
