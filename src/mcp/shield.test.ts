import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { stdioLaunch } from './manager.js';

const shield = fileURLToPath(new URL('./shield.js', import.meta.url));
// Stands in for an MCP server: reports its pid, echoes stdin, exits when stdin closes.
const SERVER = "process.stdout.write('pid ' + process.pid + '\\n'); process.stdin.on('data', (d) => process.stdout.write('echo ' + d)); process.stdin.on('end', () => process.exit(0));";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (ok: () => boolean, ms = 4000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return ok();
};

function start(): { proc: ReturnType<typeof spawn>; lines: string[] } {
  // Own process group, so the test can send a signal to "the terminal's foreground group" without hitting itself.
  const proc = spawn(process.execPath, [shield, process.execPath, '-e', SERVER], { stdio: ['pipe', 'pipe', 'inherit'], detached: true });
  const lines: string[] = [];
  proc.stdout!.on('data', (d: Buffer) => lines.push(...String(d).split('\n').filter(Boolean)));
  return { proc, lines };
}
const serverPid = async (lines: string[]): Promise<number> => {
  assert.ok(await until(() => lines.some((l) => l.startsWith('pid '))), 'server did not start');
  return Number(lines.find((l) => l.startsWith('pid '))!.slice(4));
};

describe('stdioLaunch', () => {
  it('wraps the server in the shield, except on Windows or when switched off', () => {
    const wrapped = stdioLaunch('npx', ['-y', 'x'], 'darwin', {});
    assert.equal(wrapped.command, process.execPath);
    assert.deepEqual(wrapped.args.slice(1), ['npx', '-y', 'x']);
    assert.match(wrapped.args[0]!, /shield\.js$/);
    assert.deepEqual(stdioLaunch('npx', ['-y', 'x'], 'win32', {}), { command: 'npx', args: ['-y', 'x'] });
    assert.deepEqual(stdioLaunch('npx', [], 'linux', { MCP_SHIELD: 'false' }), { command: 'npx', args: [] });
  });
});

describe('shield', { skip: process.platform === 'win32' }, () => {
  it('keeps the server alive and talking through Ctrl+C, then stops it when the pipes close', async () => {
    const { proc, lines } = start();
    const pid = await serverPid(lines);
    process.kill(-proc.pid!, 'SIGINT');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(alive(pid), 'server died on SIGINT');
    assert.equal(proc.exitCode, null);
    proc.stdin!.write('hello\n');
    assert.ok(await until(() => lines.includes('echo hello')), 'server stopped answering');

    proc.stdin!.end();
    await once(proc, 'exit');
    assert.equal(proc.exitCode, 0);
    assert.ok(await until(() => !alive(pid)));
  });

  it('stops the server when asked to terminate', async () => {
    const { proc, lines } = start();
    const pid = await serverPid(lines);
    proc.kill('SIGTERM');
    await once(proc, 'exit');
    assert.ok(await until(() => !alive(pid)), 'server outlived the shield');
  });

  it('reports a command that cannot be started', async () => {
    const proc = spawn(process.execPath, [shield, '/nonexistent/mcp-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    await once(proc, 'exit');
    assert.equal(proc.exitCode, 127);
  });
});
