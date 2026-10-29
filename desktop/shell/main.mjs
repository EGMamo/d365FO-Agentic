// Electron main process of the D365FO Agent desktop app.
// It starts the settings app (with its tool server) and Open WebUI on this computer, shows Open WebUI as the main
// window and the settings app in a second window. Open WebUI is installed by the bundled uv on first start; when it
// cannot start, Tests, Results and Settings remain available.
import { app, BaseWindow, dialog, ipcMain, Menu, shell, WebContentsView } from 'electron';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const lib = (p) => import(pathToFileURL(join(appDir, 'dist', p)).href);

if (!app.requestSingleInstanceLock()) app.quit();

const RAIL_WIDTH = 76;
/** The strip down the left, the chat page (Open WebUI, first the splash) and the settings app, one window. */
let win;
let rail;
let chatView;
let settingsView;
let webuiUrl;
/** Open WebUI restyled to match the app (see chat.css). */
const chatCss = readFileSync(join(here, 'chat.css'), 'utf8');

/** Which page is showing: chat, or a tab of the settings app. */
let current = 'chat';
let profileInfo = { active: null, profiles: [], busy: false };
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

function status(text, line, step) {
  if (text || line) console.log(`[app] ${text ?? line}`);
  if (!chatView || chatView.webContents.isDestroyed() || webuiUrl) return;
  chatView.webContents
    .executeJavaScript(
      `window.setStatus && setStatus(${JSON.stringify(text ?? null)}, ${JSON.stringify(line ?? null)});` +
        (step ? `window.setStep && setStep(${JSON.stringify(step)});` : ''),
    )
    .catch(() => {});
}

function guardLinks(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    // Reports and downloads of the settings app open inside the app; anything else in the default browser.
    if (ui && url.startsWith(ui.url)) return { action: 'allow' };
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function layout() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  rail.setBounds({ x: 0, y: 0, width: RAIL_WIDTH, height });
  const w = Math.max(width - RAIL_WIDTH, 0);
  chatView?.setBounds({ x: RAIL_WIDTH, y: 0, width: w, height });
  settingsView?.setBounds({ x: RAIL_WIDTH, y: 0, width: w, height });
}

const run = (view, code) => view.webContents.executeJavaScript(code).catch(() => undefined);

/** Chat, or one tab of the settings app: 'chat' | 'profiles' | 'models' | 'cases' | 'run' | 'results' | 'history'. */
async function go(id) {
  if (!win || win.isDestroyed()) return;
  if (!['chat', 'cases', 'results', 'settings'].includes(id)) return;
  const chatPage = id === 'chat';
  if (!chatPage && !settingsView) return; // the settings app is still starting
  current = id;
  chatView.setVisible(chatPage);
  layout();
  settingsView?.setVisible(!chatPage);
  if (!chatPage) await run(settingsView, `showTab(${JSON.stringify(id)})`);
  (chatPage ? chatView : settingsView).webContents.focus();
  pushState();
}

function pushState() {
  if (rail && !rail.webContents.isDestroyed())
    rail.webContents.send('rail:state', { current, profile: profileInfo.active, busy: profileInfo.busy });
}

/** Reads the profile in use and whether a run is going, from the settings app's own page. */
async function pollProfiles() {
  if (!settingsView || settingsView.webContents.isDestroyed()) return;
  const info = await run(settingsView, `window.appInfo ? appInfo() : null`);
  if (!info) return;
  if (JSON.stringify(info) === JSON.stringify(profileInfo)) return;
  profileInfo = info;
  pushState();
}

function profileMenu() {
  if (!settingsView) return;
  const { active, profiles, busy } = profileInfo;
  const items = profiles.map((name) => ({
    label: name,
    type: 'radio',
    checked: name === active,
    enabled: !busy,
    click: async () => {
      await run(settingsView, `useEnvironment(${JSON.stringify(name)}).catch(fail)`);
      void pollProfiles();
    },
  }));
  if (!items.length) items.push({ label: 'No profiles yet', enabled: false });
  items.push({ type: 'separator' });
  if (busy) items.push({ label: 'A run is in progress; switching is off until it ends', enabled: false });
  items.push({ label: 'Manage environments…', click: () => void go('settings') });
  Menu.buildFromTemplate(items).popup({ window: win });
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'App',
      submenu: [
        ...[
          ['Chat', 'chat'],
          ['Tests', 'cases'],
          ['Results', 'results'],
          ['Settings', 'settings'],
        ].map(([label, id], i) => ({ label, accelerator: `CmdOrCtrl+${i + 1}`, click: () => void go(id) })),
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

async function startOpenWebUi() {
  const owui = await lib('desktop/openwebui.js');
  const paths = { uv: uvPath(), dataRoot: app.getPath('userData') };
  if (!(await owui.isInstalled(paths))) {
    status(
      'Setting up the chat for the first time. This downloads a few hundred MB and takes a few minutes; later starts take under a minute.',
      undefined,
      'install',
    );
    await owui.install(paths, (line) => status(undefined, line));
  }
  const chat = { url: `${ui.url}model/v1`, key: ui.toolToken };
  const port = await owui.freePort();
  const env = owui.serveEnv({
    dataDir: owui.layout(paths).data,
    toolUrl: `${ui.url}tools`,
    toolKey: ui.toolToken,
    chat,
    model: 'd365fo-claude',
  });
  status('Starting the chat…', undefined, 'start');
  webui = owui.serve(paths, port, env, (line) => status(undefined, line));
  let failed;
  webui.on('error', (e) => (failed = e));
  webui.on('exit', (code) => {
    webui = undefined;
    failed ??= new Error(`Open WebUI exited (code ${code}).`);
    if (!quitting && ready)
      void dialog.showMessageBox({
        type: 'warning',
        message: 'The chat stopped',
        detail: `${failed.message} The settings app still works; restart the app to try again.`,
      });
  });
  const url = `http://127.0.0.1:${port}`;
  const up = await waitFor(`${url}/health`, 240_000, () => failed);
  if (!up) throw failed ?? new Error('Open WebUI did not start in time.');
  status('Connecting the chat to your tests…', undefined, 'connect');
  // Open WebUI keeps its first-start settings; the tool server address and key are refreshed every time.
  try {
    await owui.syncToolServer(url, owui.toolConnection({ toolUrl: `${ui.url}tools`, toolKey: ui.toolToken }));
  } catch (e) {
    status(undefined, `Could not refresh the tool server in the chat: ${e.message}`);
  }
  try {
    await owui.syncChatModel(url, chat);
  } catch (e) {
    status(undefined, `Could not refresh the chat model: ${e.message}`);
  }
  ready = true;
  webuiUrl = url;
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
  win = new BaseWindow({ width: 1320, height: 860, minWidth: 900, minHeight: 600, title: 'D365FO Agent' });
  rail = new WebContentsView({
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  chatView = new WebContentsView({
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  // Once Open WebUI loads, it gets the app's look; the splash page has its own.
  chatView.webContents.on('dom-ready', () => {
    if (webuiUrl && chatView.webContents.getURL().startsWith(webuiUrl))
      chatView.webContents.insertCSS(chatCss).catch(() => undefined);
  });
  win.contentView.addChildView(chatView);
  win.contentView.addChildView(rail);
  win.on('resize', layout);
  win.on('close', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  guardLinks(chatView.webContents);
  ipcMain.on('rail:go', (_e, id) => void go(id));
  ipcMain.on('rail:profile-menu', profileMenu);
  layout();
  await Promise.all([
    rail.webContents.loadFile(join(here, 'rail.html')),
    chatView.webContents.loadFile(join(here, 'splash.html')),
  ]);
  pushState();

  const root = workspace();
  process.chdir(root);
  const { startUiServer } = await lib('ui/server.js');
  const { agentHome } = await lib('profiles/paths.js');
  const home = agentHome();
  // The agent's own commands run on this app's Electron in Node mode, so nothing else needs to be installed.
  const { environmentForChild } = await lib('config/load-env.js');
  const childEnv = () => ({ ...environmentForChild(), ELECTRON_RUN_AS_NODE: '1' });
  status('Starting the test app…', undefined, 'app');
  ui = await startUiServer({ home, root, childEnv });

  // The settings app loads right away, so profiles can be set up while the chat installs on first start.
  settingsView = new WebContentsView();
  win.contentView.addChildView(settingsView);
  settingsView.setVisible(false);
  guardLinks(settingsView.webContents);
  layout();
  await settingsView.webContents.loadURL(ui.openUrl);
  await run(settingsView, `document.body.classList.add('embedded')`);
  void pollProfiles();
  // The page reports changes itself (appChanged); a slow poll catches anything it missed.
  settingsView.webContents.on('console-message', (...args) => {
    const message = typeof args[0] === 'object' && args[0] ? args[0].message : args[2];
    if (message === 'd365fo:app-changed') void pollProfiles();
  });
  setInterval(() => void pollProfiles(), 10_000).unref();

  try {
    const url = await startOpenWebUi();
    if (quitting) return;
    await chatView.webContents.loadURL(url);
    if (current === 'chat') await go('chat');
  } catch (e) {
    if (quitting) return;
    status(`The chat could not start: ${e.message}`, undefined, 'failed');
    await dialog.showMessageBox(win, {
      type: 'warning',
      message: 'Open WebUI could not start',
      detail: `${e.message}\n\nTests, Results and Settings remain available. Restart the app to retry Chat.`,
    });
    if (current === 'chat') await go('chat');
  }
}

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on('activate', () => win?.show());
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
