import http from 'node:http';
import tls from 'node:tls';

/** Hosts that must never go through a corporate proxy: the app's own local services. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

export interface NetworkSetup {
  /** The proxy Node now uses for fetch and http(s) requests, if any. */
  proxy?: string;
  /** How many certificates from the operating system's store were added to Node's bundled list. */
  systemCertificates: number;
  /** Plain explanations of what could not be set up; never fatal. */
  notes: string[];
}

interface NetworkApis {
  getCACertificates?: (type: 'default' | 'system' | 'bundled' | 'extra') => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
  setGlobalProxyFromEnv?: (env?: NodeJS.ProcessEnv) => unknown;
}

const nodeApis = (): NetworkApis => ({
  getCACertificates: (tls as unknown as NetworkApis).getCACertificates,
  setDefaultCACertificates: (tls as unknown as NetworkApis).setDefaultCACertificates,
  setGlobalProxyFromEnv: (http as unknown as NetworkApis).setGlobalProxyFromEnv,
});

const off = (v: string | undefined): boolean => /^(0|false|no|off)$/i.test(v?.trim() ?? '');

export function proxyFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy].map((v) => v?.trim()).find(Boolean);
}

/** NO_PROXY with the app's loopback services added, so a proxy never sees local traffic. */
export function withLocalNoProxy(value: string | undefined): string {
  const entries = (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  for (const host of LOCAL_HOSTS) if (!entries.includes(host)) entries.push(host);
  return entries.join(',');
}

/**
 * Makes outbound HTTPS work on corporate networks, for model, Azure DevOps and Microsoft Learn calls:
 *
 * - Trusts the operating system's certificate store in addition to Node's bundled list. A TLS-inspecting proxy
 *   re-signs traffic with a company root that IT installs in the OS store; Node ignores that store by default and
 *   fails with "self-signed certificate in certificate chain". `D365FO_SYSTEM_CA=false` turns this off;
 *   `NODE_EXTRA_CA_CERTS=<pem file>` still works for a root that is not in the OS store.
 * - Routes fetch and http(s) through HTTPS_PROXY / HTTP_PROXY when set, honouring NO_PROXY.
 *
 * Needs Node 22.15+ / 24 (the desktop app's runtime); on older Node it reports what it skipped and changes nothing.
 * Idempotent; call once at process start, before the first request.
 */
export function configureNetwork(env: NodeJS.ProcessEnv = process.env, apis: NetworkApis = nodeApis()): NetworkSetup {
  const setup: NetworkSetup = { systemCertificates: 0, notes: [] };

  if (!off(env.D365FO_SYSTEM_CA)) {
    if (apis.getCACertificates && apis.setDefaultCACertificates) {
      try {
        const current = apis.getCACertificates('default');
        const known = new Set(current);
        const added = apis.getCACertificates('system').filter((c) => !known.has(c));
        if (added.length) apis.setDefaultCACertificates([...current, ...added]);
        setup.systemCertificates = added.length;
      } catch (e) {
        setup.notes.push(`The system certificate store could not be read (${(e as Error).message.split('\n')[0]}). Set NODE_EXTRA_CA_CERTS to your company root certificate if HTTPS requests fail.`);
      }
    } else {
      setup.notes.push('This Node.js version cannot read the system certificate store. Use NODE_EXTRA_CA_CERTS for a company root certificate.');
    }
  }

  const proxy = proxyFromEnv(env);
  if (proxy) {
    if (apis.setGlobalProxyFromEnv) {
      try {
        const noProxy = withLocalNoProxy(env.NO_PROXY ?? env.no_proxy);
        env.NO_PROXY = noProxy;
        apis.setGlobalProxyFromEnv({ ...env, NO_PROXY: noProxy, no_proxy: noProxy });
        setup.proxy = proxy;
      } catch (e) {
        setup.notes.push(`The proxy ${redactProxy(proxy)} could not be used: ${(e as Error).message.split('\n')[0]}`);
      }
    } else {
      setup.notes.push(`A proxy is set (${redactProxy(proxy)}), but this Node.js version cannot route requests through it.`);
    }
  }
  return setup;
}

/** A proxy URL without its password, for logs and setup checks. */
export function redactProxy(proxy: string): string {
  try {
    const url = new URL(proxy);
    if (url.password) url.password = '***';
    return url.toString().replace(/\/$/, '');
  } catch {
    return proxy.replace(/\/\/[^@/]*@/, '//***@');
  }
}

/** Converts an Electron/Chromium proxy rule ("PROXY host:port; DIRECT") into a proxy URL, or undefined for DIRECT. */
export function proxyFromRule(rule: string | undefined): string | undefined {
  for (const part of (rule ?? '').split(';').map((p) => p.trim())) {
    const m = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(part);
    if (m) return `${m[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${m[2]}`;
    if (/^DIRECT$/i.test(part)) return undefined;
  }
  return undefined;
}
