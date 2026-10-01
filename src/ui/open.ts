import { spawn } from 'node:child_process';

/** Opens a URL in the user's default browser. Resolves false when no opener could be started. */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const [cmd, args]: [string, string[]] =
    platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
