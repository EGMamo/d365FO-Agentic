// Electron main process: one local Node application and one web app containing Chat, Tests, Results and Settings.
// The shell owns packaging, navigation and native confirmations; it contains no test or Chat model logic.
import { app, BaseWindow, dialog, ipcMain, Menu, shell, WebContentsView } from 'electron';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const lib = (p) => import(pathToFileURL(join(appDir, 'dist', p)).href);

// Smoke tests isolate application state, profiles and the workspace.
if (process.env.D365FO_DESKTOP_DATA) {
  mkdirSync(process.env.D365FO_DESKTOP_DATA, { recursive: true, mode: 0o700 });
  app.setPath('userData', process.env.D365FO_DESKTOP_DATA);
}
if (!app.requestSingleInstanceLock()) app.quit();

const RAIL_WIDTH = 76;
let win;
let rail;
let appView;
let ui;
let current = 'chat';
let profileInfo = { active: null, profiles: [], busy: false };
let quitting = false;

/** Test cases, reports and what the agent learns live here, where the user can see them. */
function workspace() {
  const dir = process.env.D365FO_WORKSPACE || join(app.getPath('documents'), 'D365FO Agent');
  if (!existsSync(join(dir, 'examples'))) {
    mkdirSync(dir, { recursive: true });
    cpSync(join(appDir, 'examples'), join(dir, 'examples'), { recursive: true });
  }
  return dir;
}

function guardLinks(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (ui && url.startsWith(ui.url)) return { action: 'allow' };
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const guardNavigation = (event, url) => {
    const allowed = ui && new URL(url).origin === new URL(ui.url).origin;
    if (!allowed) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
}

function layout() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  rail.setBounds({ x: 0, y: 0, width: RAIL_WIDTH, height });
  appView?.setBounds({ x: RAIL_WIDTH, y: 0, width: Math.max(width - RAIL_WIDTH, 0), height });
}

const run = (view, code) => view.webContents.executeJavaScript(code).catch(() => undefined);

async function go(id) {
  if (!win || win.isDestroyed() || !appView || !['chat', 'cases', 'results', 'settings'].includes(id)) return;
  current = id;
  await run(appView, `showTab(${JSON.stringify(id)})`);
  layout();
  appView.webContents.focus();
  pushState();
}

function pushState() {
  if (rail && !rail.webContents.isDestroyed()) rail.webContents.send('rail:state', { current, profile: profileInfo.active, busy: profileInfo.busy });
}

/** Read shared navigation state from the app rather than duplicating profile/run state in Electron. */
async function pollProfiles() {
  if (!appView || appView.webContents.isDestroyed()) return;
  const info = await run(appView, `window.appInfo ? appInfo() : null`);
  if (!info || JSON.stringify(info) === JSON.stringify(profileInfo)) return;
  profileInfo = info;
  pushState();
}

function profileMenu() {
  if (!appView) return;
  const { active, profiles, busy } = profileInfo;
  const items = profiles.map((name) => ({
    label: name,
    type: 'radio',
    checked: name === active,
    enabled: !busy,
    click: async () => {
      await run(appView, `useEnvironment(${JSON.stringify(name)}).catch(fail)`);
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
        ...[['Chat', 'chat'], ['Tests', 'cases'], ['Results', 'results'], ['Settings', 'settings']]
          .map(([label, id], i) => ({ label, accelerator: `CmdOrCtrl+${i + 1}`, click: () => void go(id) })),
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

async function approveToolAction(action) {
  if (quitting || !win || win.isDestroyed()) return false;
  const upload = action.kind === 'upload';
  const details = [
    `Environment: ${action.profile || 'None selected'}`,
    ...(action.environment ? [`F&O address: ${action.environment.url}`, `Legal entity: ${action.environment.company}`] : []),
    ...(action.source?.type === 'local' ? [`Cases folder: ${action.source.folder}`] : []),
    ...(action.source?.type === 'devops' ? [`DevOps plan/suite: ${action.source.plan || 'default'} / ${action.source.suite || 'default'}`] : []),
    ...(action.cases?.length ? [`Cases: ${action.cases.join(', ')}`] : []),
    ...(action.runId ? [`Saved run: ${action.runId}`] : []),
    ...(action.plan ? [`Upload plan: ${action.plan}`] : []),
  ];
  const result = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Cancel', upload ? 'Upload results' : 'Run tests'], defaultId: 0, cancelId: 0,
    message: upload ? 'Allow Chat to upload these results to Azure DevOps?' : 'Allow Chat to run these tests in F&O?',
    detail: details.join('\n'), noLink: true,
  });
  return !quitting && result.response === 1;
}

async function main() {
  await app.whenReady();
  buildMenu();
  win = new BaseWindow({ width: 1320, height: 860, minWidth: 900, minHeight: 600, title: 'D365FO Agent' });
  const preferences = { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true };
  rail = new WebContentsView({ webPreferences: preferences });
  appView = new WebContentsView({ webPreferences: preferences });
  win.contentView.addChildView(appView);
  win.contentView.addChildView(rail);
  win.on('resize', layout);
  win.on('close', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  guardLinks(appView.webContents);
  const isRailSender = (event) => event.sender === rail.webContents && event.senderFrame?.url === pathToFileURL(join(here, 'rail.html')).href;
  ipcMain.on('rail:go', (event, id) => { if (isRailSender(event)) void go(id); });
  ipcMain.on('rail:profile-menu', (event) => { if (isRailSender(event)) profileMenu(); });
  layout();
  await rail.webContents.loadFile(join(here, 'rail.html'));
  pushState();

  const root = workspace();
  process.chdir(root);
  const { startUiServer } = await lib('ui/server.js');
  const { agentHome } = await lib('profiles/paths.js');
  const home = agentHome();
  const { environmentForChild } = await lib('config/load-env.js');
  const childEnv = () => ({ ...environmentForChild(), ELECTRON_RUN_AS_NODE: '1' });
  ui = await startUiServer({
    home,
    root,
    childEnv,
    approveToolAction,
  });
  await appView.webContents.loadURL(ui.openUrl);
  await run(appView, `document.body.classList.add('embedded')`);
  await go('chat');
  void pollProfiles();
  appView.webContents.on('console-message', (...args) => {
    const message = typeof args[0] === 'object' && args[0] ? args[0].message : args[2];
    if (message === 'd365fo:app-changed') void pollProfiles();
  });
  setInterval(() => void pollProfiles(), 10_000).unref();
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
  void ui?.close();
});
app.on('window-all-closed', () => app.quit());
main().catch((e) => {
  dialog.showErrorBox('D365FO Agent could not start', String(e?.stack ?? e));
  app.quit();
});
