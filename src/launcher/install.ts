import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { iconIco } from './icon.js';

const run = promisify(execFile);

export const APP_TITLE = 'D365FO Agent';

export interface LauncherContext {
  platform: NodeJS.Platform;
  /** Folder of this project (where dist/ lives). */
  repoRoot: string;
  /** Absolute path of node, so the icon works even when the desktop has a different PATH than a terminal. */
  nodePath: string;
  /** The per-user app folder: holds the launch script, the icon and the profiles. */
  home: string;
  desktop: string;
  userHome?: string;
}

export interface PlannedFile {
  path: string;
  content: string | Buffer;
  executable?: boolean;
  /** Copied from this path instead of `content`. */
  copyFrom?: string;
}

export interface LauncherPlan {
  files: PlannedFile[];
  /** Windows only: a PowerShell script that turns the launch script into a desktop shortcut. */
  shortcutScript?: string;
  /** What the user double-clicks. */
  entry: string;
}

const sh = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;
const ps = (v: string): string => `'${v.replace(/'/g, "''")}'`;
const desktopEntryValue = (v: string): string => v.replace(/\\/g, '\\\\');
const desktopExecArg = (v: string): string => `"${v.replace(/(["`$\\])/g, '\\$1')}"`;

function posixScript(ctx: LauncherContext): string {
  return [
    '#!/bin/bash',
    `cd ${sh(ctx.repoRoot)} || { echo "Project folder not found: ${ctx.repoRoot.replace(/"/g, '')}"; read -r -p "Press Return to close."; exit 1; }`,
    `if [ ! -f dist/cli/index.js ]; then echo "The agent is not built yet. Run: npm run build"; read -r -p "Press Return to close."; exit 1; fi`,
    `echo "Starting ${APP_TITLE}. Keep this window open while you use it; close it to stop."`,
    `${sh(ctx.nodePath)} dist/cli/index.js ui`,
    'status=$?',
    'echo',
    'read -r -p "The server stopped (exit $status). Press Return to close." _',
    '',
  ].join('\n');
}

function windowsScript(ctx: LauncherContext): string {
  return [
    '@echo off',
    `title ${APP_TITLE}`,
    `cd /d "${ctx.repoRoot}" || (echo Project folder not found. & pause & exit /b 1)`,
    'if not exist dist\\cli\\index.js (echo The agent is not built yet. Run: npm run build & pause & exit /b 1)',
    `echo Starting ${APP_TITLE}. Keep this window open while you use it; close it to stop.`,
    `"${ctx.nodePath}" dist\\cli\\index.js ui`,
    'echo.',
    'echo The server stopped. Press any key to close.',
    'pause >nul',
    '',
  ].join('\r\n');
}

/** Describes the files to create for a platform. Pure, so it can be tested without touching the disk. */
export function planLauncher(ctx: LauncherContext): LauncherPlan {
  if (ctx.platform === 'darwin') {
    const entry = join(ctx.desktop, `${APP_TITLE}.command`);
    return { entry, files: [{ path: entry, content: posixScript(ctx), executable: true }] };
  }
  if (ctx.platform === 'win32') {
    const script = join(ctx.home, 'launch.cmd');
    const icon = join(ctx.home, 'icon.ico');
    const entry = join(ctx.desktop, `${APP_TITLE}.lnk`);
    const shortcutScript = [
      '$ws = New-Object -ComObject WScript.Shell',
      `$s = $ws.CreateShortcut(${ps(entry)})`,
      `$s.TargetPath = ${ps(script)}`,
      `$s.WorkingDirectory = ${ps(ctx.repoRoot)}`,
      `$s.IconLocation = ${ps(icon)}`,
      `$s.Description = ${ps(`Start ${APP_TITLE} in your browser`)}`,
      '$s.Save()',
    ].join('; ');
    return {
      entry,
      shortcutScript,
      files: [
        { path: script, content: windowsScript(ctx) },
        { path: icon, content: iconIco(128) },
      ],
    };
  }
  const script = join(ctx.home, 'launch.sh');
  const icon = join(ctx.home, 'icon.svg');
  const desktopFile = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_TITLE}`,
    'Comment=Manage settings and start the D365FO test agent in your browser',
    `Exec=${desktopExecArg('/bin/bash')} ${desktopExecArg(script)}`,
    `Icon=${desktopEntryValue(icon)}`,
    'Terminal=true',
    'Categories=Development;',
    '',
  ].join('\n');
  const entry = join(ctx.desktop, 'd365fo-agent.desktop');
  return {
    entry,
    files: [
      { path: script, content: posixScript(ctx), executable: true },
      { path: icon, content: '', copyFrom: join(ctx.repoRoot, 'web', 'icon.svg') },
      { path: entry, content: desktopFile, executable: true },
      { path: join(ctx.userHome ?? homedir(), '.local', 'share', 'applications', 'd365fo-agent.desktop'), content: desktopFile, executable: true },
    ],
  };
}

export async function desktopDirectory(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string> {
  if (platform === 'win32') {
    try {
      const { stdout } = await run('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { timeout: 15_000 });
      if (stdout.trim()) return stdout.trim();
    } catch {
      /* fall through */
    }
    return join(env.USERPROFILE || home, 'Desktop');
  }
  if (platform === 'linux') {
    try {
      const text = await readFile(join(env.XDG_CONFIG_HOME || join(home, '.config'), 'user-dirs.dirs'), 'utf8');
      const m = /^XDG_DESKTOP_DIR="?([^"\n]+)"?/m.exec(text);
      if (m) return m[1].replace('$HOME', home);
    } catch {
      /* fall through */
    }
  }
  return join(home, 'Desktop');
}

export function defaultRepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export async function installLauncher(ctx: LauncherContext): Promise<LauncherPlan> {
  const plan = planLauncher(ctx);
  for (const f of plan.files) {
    await mkdir(dirname(f.path), { recursive: true });
    if (f.copyFrom) await copyFile(f.copyFrom, f.path);
    else await writeFile(f.path, f.content);
    if (f.executable) await chmod(f.path, 0o755);
  }
  if (plan.shortcutScript) await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', plan.shortcutScript], { timeout: 30_000 });
  return plan;
}

export async function uninstallLauncher(ctx: LauncherContext): Promise<string[]> {
  const plan = planLauncher(ctx);
  const targets = [plan.entry, ...plan.files.map((f) => f.path)].filter((p) => !p.startsWith(join(ctx.home, 'profiles')));
  const removed: string[] = [];
  for (const p of new Set(targets)) {
    try {
      await rm(p);
      removed.push(p);
    } catch {
      /* already gone */
    }
  }
  return removed;
}
