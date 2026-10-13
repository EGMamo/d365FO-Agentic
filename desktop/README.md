# D365FO Agent desktop app

An installer for people who should not need a terminal. It opens one window with a strip of icons down the left side: **Chat** (Open WebUI,
already connected to the D365FO test runner tools), then **Profiles**, **Test cases**, **Run**, **Results** and
**History** from the settings app (Ctrl/Cmd+1 to 6). The profile in use is shown at the bottom of the strip; click it to
switch. Switching is off while a run is in progress. No Docker, Node.js or Python needs to be installed.

## What happens on a user's computer

1. They install `D365FO Agent-<version>.dmg` (macOS, Apple Silicon only: M1 or newer, no Intel build) or `D365FO Agent Setup <version>.exe` (Windows) and open it.
2. The app starts the settings app and its tool server on `127.0.0.1` on Electron's own Node runtime.
3. **First start only:** the bundled [uv](https://github.com/astral-sh/uv) downloads a standalone Python 3.11 and
   installs the pinned Open WebUI (`src/desktop/openwebui.ts`) into the app's data folder. This needs internet access
   to PyPI and GitHub (python-build-standalone), takes about 2 to 3 minutes on a fast connection and about 0.8 GB on disk (measured on Linux; macOS and Windows not measured yet). Open WebUI runs in its own slim mode: the install leaves out its local AI stack (PyTorch and its GPU libraries, embeddings, speech and image recognition, the bundled vector database) and the cloud storage clients, which took the Linux install from 7.1 GB to 0.7 GB. The list is `EXCLUDED_PACKAGES` in `src/desktop/openwebui.ts`. Chats use a hosted or local model through a connection, so none of that is needed; uploading documents for search and local voice input do not work. Features a test chat does not use are switched off with Open WebUI's own settings (`DISABLED_FEATURES` in the same file): sharing, channels, notes, folders, calendar, automations, web search, image and code tools, memories, cloud drives and extra model calls. A splash screen
   shows progress.
4. Open WebUI starts (20 to 40 seconds; the window shows progress meanwhile) on a free loopback port without a sign-in screen (one local user), with the tool server, starter
   prompts and, when the profile in use speaks an OpenAI-style API (OpenAI, Anthropic, GitHub Models, Ollama or another
   OpenAI-compatible server), that model as its chat model. With GitHub Copilot, add a model under Admin Panel >
   Settings > Connections. Open WebUI keeps the chat model after its first start, so it is a global setting you manage in Open WebUI, not per profile. The tool server's address and key are refreshed on every start.
5. The first test run downloads the Playwright browser (about 300 MB), using the Playwright MCP bundled in the app.

If Open WebUI cannot be installed or started, the app opens the settings app instead; its **Chat** tab uses the
profile's model directly and needs no Open WebUI.

Data locations: test cases, reports and the knowledge base in `Documents/D365FO Agent` (sample test cases are copied
there on first start); profiles in the usual agent folder (see the main README); Open WebUI, its Python and its chats
in the app's data folder (`~/Library/Application Support/D365FO Agent`, `%APPDATA%\D365FO Agent`).

## Building

```bash
npm ci && npm run build        # in the project folder
cd desktop
npm ci
npm run dist                   # installer for this OS in desktop/release/
npm start                      # or run it without packaging (uses `uv` from PATH, or D365FO_UV)
```

`npm run dist` stages the built agent into `desktop/app` with the pinned `@playwright/mcp` (`bundle.playwrightMcp` in
`package.json`), downloads the pinned uv for the target into `desktop/resources/uv`, and runs electron-builder.
GitHub Actions builds both installers on every change to the desktop code, on `v*` tags and on demand
(`.github/workflows/desktop.yml`); download them from the run's artifacts.

## Signing (not done yet)

The installers are unsigned, so macOS Gatekeeper and Windows SmartScreen warn on first open (macOS: right-click >
Open; Windows: More info > Run anyway). To sign them in the workflow, add these repository secrets and drop
`CSC_IDENTITY_AUTO_DISCOVERY: 'false'`:

- macOS: an Apple Developer ID Application certificate as `CSC_LINK` (base64 .p12) and `CSC_KEY_PASSWORD`, plus
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for notarization (set `mac.notarize: true`).
- Windows: a code-signing certificate as `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`, or Azure Trusted Signing
  (`win.azureSignOptions`).

## Open WebUI licence

Open WebUI from v0.6.6 is under the Open WebUI License: BSD-3 plus a branding clause. The app runs Open WebUI
unmodified, installed from PyPI on the user's computer, and does not remove or change its name or logo, which the
licence allows. Do not hide or replace Open WebUI's branding in the chat window (for example with `WEBUI_NAME` or
custom CSS) without an Open WebUI enterprise licence, unless the deployment stays under 50 users in any 30-day period.
See <https://docs.openwebui.com/license/>.

## Follow-ups

- Code signing and notarization (above), and auto-update (electron-builder `publish` plus `electron-updater`).
- An offline installer that ships Python and Open WebUI inside (about 0.8 GB per OS on Linux, since the slim install).
- Session sign-in (`session-login`) still runs through `npx playwright`; use a test account and password in the
  profile, or save the session from a computer with Node.js.
