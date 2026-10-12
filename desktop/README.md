# D365FO Agent desktop app

An installer for people who should not need a terminal. It opens one app window with **Open WebUI** as the chat,
already connected to the D365FO test runner tools, and a second window (App > Settings, or Ctrl/Cmd+2) with the
settings app: profiles, test cases, runs, results and history. No Docker, Node.js or Python needs to be installed.

## What happens on a user's computer

1. They install `D365FO Agent-<version>.dmg` (macOS) or `D365FO Agent Setup <version>.exe` (Windows) and open it.
2. The app starts the settings app and its tool server on `127.0.0.1` on Electron's own Node runtime.
3. **First start only:** the bundled [uv](https://github.com/astral-sh/uv) downloads a standalone Python 3.11 and
   installs the pinned Open WebUI (`src/desktop/openwebui.ts`) into the app's data folder. This needs internet access
   to PyPI and GitHub (python-build-standalone), takes about 4 minutes on a fast connection and is roughly 3 GB on disk (measured on Linux with the CPU build of PyTorch; macOS and Windows get the same CPU build from PyPI). A splash screen
   shows progress.
4. Open WebUI starts (20 to 40 seconds; the window shows progress meanwhile) on a free loopback port without a sign-in screen (one local user), with the tool server, starter
   prompts and, when the profile in use speaks an OpenAI-style API (OpenAI, Anthropic, GitHub Models, Ollama or another
   OpenAI-compatible server), that model as its chat model. With GitHub Copilot, add a model under Admin Panel >
   Settings > Connections. Open WebUI keeps these settings after its first start.
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
- An offline installer that ships Python and Open WebUI inside (about 3 GB per OS and architecture).
- Session sign-in (`session-login`) still runs through `npx playwright`; use a test account and password in the
  profile, or save the session from a computer with Node.js.
