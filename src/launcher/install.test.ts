import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { iconIco, iconPng } from './icon.js';
import { planLauncher, type LauncherContext } from './install.js';

const base: LauncherContext = { platform: 'linux', repoRoot: '/opt/my repo', nodePath: '/usr/bin/node', home: '/home/a/.config/d365fo-agent', desktop: '/home/a/Desktop', userHome: '/home/a' };

describe('planLauncher', () => {
  it('macOS: one double-clickable .command on the desktop', () => {
    const p = planLauncher({ ...base, platform: 'darwin', repoRoot: "/Users/a/it's here" });
    // join: the plan uses this computer's separator, so the tests pass on Windows too.
    assert.equal(p.entry, join('/home/a/Desktop', 'D365FO Agent.command'));
    assert.equal(p.files.length, 1);
    assert.ok(p.files[0].executable);
    const text = String(p.files[0].content);
    assert.match(text, /^#!\/bin\/bash/);
    assert.ok(text.includes(`cd '/Users/a/it'\\''s here'`), 'paths are shell-quoted');
    assert.match(text, /'\/usr\/bin\/node' dist\/cli\/index\.js ui/);
  });

  it('Windows: a launch script, an .ico and a shortcut script', () => {
    const p = planLauncher({ ...base, platform: 'win32', repoRoot: 'C:\\src\\d365', nodePath: 'C:\\Program Files\\nodejs\\node.exe', home: 'C:\\Users\\a\\AppData\\Roaming\\d365fo-agent', desktop: "C:\\Users\\a\\O'Neil\\Desktop" });
    assert.ok(p.entry.endsWith('D365FO Agent.lnk'));
    const cmd = p.files.find((f) => String(f.path).endsWith('launch.cmd'))!;
    assert.match(String(cmd.content), /"C:\\Program Files\\nodejs\\node.exe" dist\\cli\\index.js ui/);
    assert.ok(String(cmd.content).includes('\r\n'));
    assert.ok(Buffer.isBuffer(p.files.find((f) => String(f.path).endsWith('.ico'))!.content));
    assert.match(p.shortcutScript ?? '', /CreateShortcut\('C:\\Users\\a\\O''Neil\\Desktop/);
  });

  it('Linux: a .desktop file on the desktop and in the applications menu, running in a terminal', () => {
    const p = planLauncher(base);
    const desktopFiles = p.files.filter((f) => String(f.path).endsWith('.desktop'));
    assert.deepEqual(desktopFiles.map((f) => f.path), [join('/home/a/Desktop', 'd365fo-agent.desktop'), join('/home/a', '.local', 'share', 'applications', 'd365fo-agent.desktop')]);
    const text = String(desktopFiles[0].content);
    assert.match(text, /^\[Desktop Entry\]/);
    assert.match(text, /Terminal=true/);
    assert.ok(text.includes(`Exec="/bin/bash" "${join('/home/a/.config/d365fo-agent', 'launch.sh')}"`), text);
    assert.ok(desktopFiles.every((f) => f.executable));
  });
});

describe('icon', () => {
  it('produces a valid PNG and an ICO wrapping it', () => {
    const png = iconPng(64);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), 64);
    const ico = iconIco(64);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt32LE(14), iconPng(64).length);
    assert.deepEqual([...ico.subarray(22, 26)], [0x89, 0x50, 0x4e, 0x47]);
  });
});
