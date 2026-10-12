// Electron main process of the D365FO Agent desktop app.
// It starts the settings app (with its tool server) and Open WebUI on this computer, shows Open WebUI as the main
// window and the settings app in a second window. Open WebUI is installed by the bundled uv on first start; when it
// cannot start, the settings app opens instead, whose Chat tab works without it.
import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const lib = (p) => import(pathToFileURL(join(appDir, 'dist', p)).href);

if (!app.requestSingleInstanceLock()) app.quit();

let chatWin;
let settingsWin;
let ui;
let webui;
let quitting = false;
/** Open WebUI answered once; a later exit is reported to the user. */
let ready = false;

/** Test cases, reports and what the agent learns live here, where the user can see them. */
function workspace() {
  const dir = process.env.D365FO_WORKSPACE || join(app.getPath('documents'), 'D365FO Agent');
  if (!existsSync(join(dir, 'examples'))) {
    mkdirSync(dir, { recursive: true });
    cpSync(join(appDir, 'examples'), join(dir, 'examples'), { recursive: true });
  }
  return dir;
}

function uvPath() {
  if (process.env.D365FO_UV) return process.env.D365FO_UV;
  const exe = process.platform === 'win32' ? 'uv.exe' : 'uv';
  return app.isPackaged ? join(process.resourcesPath, 'uv', exe) : exe;
}

function status(text, line) {
  if (text || line) console.log(`[app] ${text ?? line}`);
  if (!chatWin || chatWin.isDestroyed()) return;
  chatWin.webContents.executeJavaScript(`window.setStatus && setStatus(${JSON.stringify(text ?? null)}, ${JSON.stringify(line ?? null)})`).catch(() => {});
}

function guardLinks(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Reports and downloads of the settings app open inside the app; anything else in the default browser.
    if (ui && url.startsWith(ui.url)) return { action: 'allow' };
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function openSettings() {
  if (!ui) return;
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();
  settingsWin = new BrowserWindow({ width: 1180, height: 820, title: 'D365FO Agent settings', autoHideMenuBar: true });
  guardLinks(settingsWin);
  void settingsWin.loadURL(ui.openUrl);
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'App',
      submenu: [
        { label: 'Chat', accelerator: 'CmdOrCtrl+1', click: () => chatWin?.show() },
        { label: 'Settings, test cases and results', accelerator: 'CmdOrCtrl+2', click: openSettings },
        { type: 'separator' },
        { label: 'Open the workspace folder', click: () => shell.openPath(workspace()) },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function waitFor(url, ms, stopped = () => undefined) {
  const end = Date.now() + ms;
  while (Date.now() < end && !quitting && !stopped()) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function startOpenWebUi(home) {
  const owui = await lib('desktop/openwebui.js');
  const { ProfileStore } = await lib('profiles/store.js');
  const { parseConfig } = await lib('config/index.js');
  const paths = { uv: uvPath(), dataRoot: app.getPath('userData') };
  if (!(await owui.isInstalled(paths))) {
    status('Setting up the chat for the first time. This downloads a few hundred MB and takes a few minutes; later starts take under a minute.');
    await owui.install(paths, (line) => status(undefined, line));
  }
  // The chat model Open WebUI starts with, from the profile in use (used on Open WebUI's first start).
  let chat;
  try {
    const store = new ProfileStore(home);
    const active = await store.getActive();
    if (active) chat = owui.chatConnection(parseConfig(Object.fromEntries((await store.read(active, true)).map((e) => [e.key, e.value]))));
  } catch {
    /* add a model in Open WebUI instead */
  }
  const port = await owui.freePort();
  const env = owui.serveEnv({ dataDir: owui.layout(paths).data, toolUrl: `${ui.url}tools`, toolKey: ui.toolToken, chat });
  status('Starting the chat…');
  webui = owui.serve(paths, port, env, (line) => status(undefined, line));
  let failed;
  webui.on('error', (e) => (failed = e));
  webui.on('exit', (code) => {
    webui = undefined;
    failed ??= new Error(`Open WebUI exited (code ${code}).`);
    if (!quitting && ready) void dialog.showMessageBox({ type: 'warning', message: 'The chat stopped', detail: `${failed.message} The settings app still works; restart the app to try again.` });
  });
  const url = `http://127.0.0.1:${port}`;
  const up = await waitFor(`${url}/health`, 240_000, () => failed);
  if (!up) throw failed ?? new Error('Open WebUI did not start in time.');
  ready = true;
  return url;
}

function stopOpenWebUi() {
  if (!webui?.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(webui.pid), '/T', '/F'], { windowsHide: true });
  else webui.kill('SIGTERM');
}

async function main() {
  await app.whenReady();
  buildMenu();
  chatWin = new BrowserWindow({ width: 1280, height: 860, title: 'D365FO Agent', show: true });
  guardLinks(chatWin);
  chatWin.on('close', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  await chatWin.loadFile(join(here, 'splash.html'));

  const root = workspace();
  process.chdir(root);
  const { startUiServer } = await lib('ui/server.js');
  const { agentHome } = await lib('profiles/paths.js');
  const home = agentHome();
  // The agent's own commands run on this app's Electron in Node mode, so nothing else needs to be installed.
  const childEnv = () => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1' });
  status('Starting the settings app…');
  ui = await startUiServer({ home, root, childEnv });

  try {
    const url = await startOpenWebUi(home);
    if (!quitting) await chatWin.loadURL(url);
  } catch (e) {
    if (quitting) return;
    status(`The chat could not start: ${e.message}`);
    await dialog.showMessageBox(chatWin, {
      type: 'warning',
      message: 'Open WebUI could not start',
      detail: `${e.message}\n\nThe settings app opens instead; its Chat tab works without Open WebUI.`,
    });
    await chatWin.loadURL(ui.openUrl);
  }
}

app.on('second-instance', () => {
  if (chatWin) {
    if (chatWin.isMinimized()) chatWin.restore();
    chatWin.focus();
  }
});
app.on('activate', () => chatWin?.show());
app.on('before-quit', () => {
  quitting = true;
  stopOpenWebUi();
  void ui?.close();
});
app.on('window-all-closed', () => app.quit());

main().catch((e) => {
  dialog.showErrorBox('D365FO Agent could not start', String(e?.stack ?? e));
  app.quit();
});
