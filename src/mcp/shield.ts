/**
 * Runs an MCP server out of reach of the terminal's Ctrl+C.
 *
 * A terminal sends Ctrl+C to every process in the foreground group, so the browser would die with the agent's
 * first interrupt and the case in flight could not be wound down (trace saved, reports written). This wrapper
 * ignores the interrupt and starts the real server in its own process group; the server still talks to the
 * agent over the inherited stdio pipes. It stops the server when the agent closes those pipes, asks it to
 * terminate, or goes away.
 *
 * POSIX only: the manager starts servers directly on Windows.
 * Usage: node shield.js <command> [args...]
 */
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('shield: no command given');
  process.exit(2);
}

const child = spawn(command, args, { stdio: 'inherit', detached: true });
const parent = process.ppid;

function stop(signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    // Negative pid: the whole group, so the browser the server started goes with it.
    process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

process.on('SIGINT', () => undefined);
for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    stop('SIGTERM');
    setTimeout(() => stop('SIGKILL'), 1500).unref();
  });
}
// The agent was killed without closing the pipes: do not leave a browser behind.
setInterval(() => {
  if (process.ppid !== parent) {
    stop('SIGTERM');
    setTimeout(() => stop('SIGKILL'), 1500).unref();
  }
}, 1000).unref();

child.on('error', (e) => {
  console.error(`shield: could not start ${command}: ${e.message}`);
  process.exit(127);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
