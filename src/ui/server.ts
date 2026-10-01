import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIELD_CATALOG } from '../profiles/catalog.js';
import { serverFile, tokenFile } from '../profiles/paths.js';
import { isSecretKey, ProfileError, ProfileStore } from '../profiles/store.js';

/**
 * Local web UI for managing profiles. It binds to the loopback interface only and is meant to be opened from the
 * launcher. Three checks keep other web pages and other local users away from the secrets it manages:
 * the Host header must be this server (blocks DNS rebinding), writes must come from this page (Origin and a custom
 * header, blocks cross-site forms) and every request needs the per-machine token held in a cookie.
 */
export const DEFAULT_PORT = 4365;
const COOKIE = 'd365fo_ui';
const MAX_BODY = 256 * 1024;
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

export interface UiServerOptions {
  home: string;
  /** Path of the CLI entry point, run for the "check setup" button. */
  cliPath?: string;
  port?: number;
  host?: string;
}

export interface RunningUi {
  server: Server;
  port: number;
  token: string;
  url: string;
  /** The URL that signs the browser in (sets the cookie) and then lands on the app. */
  openUrl: string;
  close: () => Promise<void>;
}

export async function loadOrCreateToken(home: string): Promise<string> {
  try {
    const t = (await readFile(tokenFile(home), 'utf8')).trim();
    if (t.length >= 32) return t;
  } catch {
    /* create below */
  }
  const token = randomBytes(24).toString('hex');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(tokenFile(home), token, { mode: 0o600 });
  return token;
}

const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function cookieValue(req: IncomingMessage): string {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return '';
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const isText = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isText ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ProfileError('Request is too large.', 413);
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new ProfileError('Request body is not valid JSON.');
  }
}

/** Runs `doctor` against a profile and returns its output with that profile's secrets scrubbed. */
async function runDoctor(store: ProfileStore, name: string, cliPath: string): Promise<{ exitCode: number | null; output: string }> {
  const secrets = (await store.read(name, true)).filter((e) => isSecretKey(e.key) && e.value.length >= 4).map((e) => e.value);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, 'doctor'], {
      env: { ...process.env, D365FO_PROFILE: name, D365FO_AGENT_HOME: store.home, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const add = (b: Buffer): void => {
      if (output.length < 20_000) output += b.toString('utf8');
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill(), 90_000);
    const done = (exitCode: number | null): void => {
      clearTimeout(timer);
      for (const s of secrets) output = output.split(s).join('***');
      resolve({ exitCode, output: output.trim() });
    };
    child.on('error', (e) => {
      output += `Could not start the check: ${e.message}`;
      done(null);
    });
    child.on('close', done);
  });
}

export async function startUiServer(opts: UiServerOptions): Promise<RunningUi> {
  const store = new ProfileStore(opts.home);
  const token = await loadOrCreateToken(opts.home);
  const host = opts.host ?? '127.0.0.1';
  let port = opts.port ?? DEFAULT_PORT;
  const cliPath = opts.cliPath ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'index.js');

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const hostHeader = (req.headers.host ?? '').toLowerCase();
    if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`) return send(res, 403, { error: 'Unexpected Host header.' });
    const url = new URL(req.url ?? '/', `http://${hostHeader}`);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
      if (!same(url.searchParams.get('token') ?? '', token)) return send(res, 403, { error: 'Wrong token.' });
      return send(res, 302, '', { Location: '/', 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` });
    }
    if (url.pathname === '/api/health') return send(res, 200, { app: 'd365fo-agent-ui' });

    if (!same(cookieValue(req), token)) {
      return send(res, 403, '<!doctype html><meta charset="utf-8"><title>D365FO Agent</title><body style="font:16px system-ui;margin:3rem"><h2>Open this from the launcher</h2><p>Use the D365FO Agent icon on your desktop, or run <code>npm run ui</code>.</p>');
    }
    if (method !== 'GET') {
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${hostHeader}`) || req.headers['x-requested-with'] !== 'd365fo-ui') return send(res, 403, { error: 'Cross-site request refused.' });
    }

    try {
      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, await readFile(join(WEB_DIR, 'index.html'), 'utf8'));
      }
      if (method === 'GET' && url.pathname === '/icon.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        return void res.end(await readFile(join(WEB_DIR, 'icon.svg')));
      }
      if (method === 'GET' && url.pathname === '/api/state') {
        return send(res, 200, { profiles: await store.list(), active: (await store.getActive()) ?? null, home: opts.home, catalog: FIELD_CATALOG });
      }
      if (method === 'POST' && url.pathname === '/api/active') {
        const body = await readJson(req);
        await store.setActive(typeof body.name === 'string' ? body.name : undefined);
        return send(res, 200, { active: (await store.getActive()) ?? null });
      }
      if (method === 'POST' && url.pathname === '/api/profiles') {
        const body = await readJson(req);
        const name = String(body.name ?? '');
        if (typeof body.copyFrom === 'string' && body.copyFrom) await store.duplicate(body.copyFrom, name);
        else await store.write(name, body.entries ?? [], 'create');
        return send(res, 201, { name });
      }
      const m = /^\/api\/profiles\/([^/]+)(\/check)?$/.exec(url.pathname);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (m[2] && method === 'POST') return send(res, 200, await runDoctor(store, name, cliPath));
        if (!m[2] && method === 'GET') return send(res, 200, { name, entries: await store.read(name) });
        if (!m[2] && method === 'PUT') {
          await store.write(name, (await readJson(req)).entries, 'replace');
          return send(res, 200, { name });
        }
        if (!m[2] && method === 'DELETE') {
          await store.delete(name);
          return send(res, 200, { deleted: name });
        }
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (e) {
      if (e instanceof ProfileError) return send(res, e.status, { error: e.message });
      console.error(`[ui] ${(e as Error).message}`);
      return send(res, 500, { error: 'Something went wrong. See the terminal window for details.' });
    }
  };

  const server = createServer((req, res) => void handler(req, res));
  // Try the preferred port and the few after it, so a second copy or another program on 4365 does not block the UI.
  const first = port;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || first === 0 || port >= first + 20) throw e;
      port++;
    }
  }
  port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/`;
  await mkdir(opts.home, { recursive: true, mode: 0o700 });
  await writeFile(serverFile(opts.home), JSON.stringify({ port, pid: process.pid }), { mode: 0o600 });
  return {
    server,
    port,
    token,
    url,
    openUrl: `${url}?token=${token}`,
    close: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(() => resolve()))),
  };
}

/** If a UI from an earlier launch is still running, returns its address so the launcher can reuse it. */
export async function findRunningUi(home: string, token: string): Promise<string | undefined> {
  try {
    const { port } = JSON.parse(await readFile(serverFile(home), 'utf8')) as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { app?: string };
    return body.app === 'd365fo-agent-ui' ? `http://127.0.0.1:${port}/?token=${token}` : undefined;
  } catch {
    return undefined;
  }
}

export const webAssetsPresent = (): boolean => existsSync(join(WEB_DIR, 'index.html'));
