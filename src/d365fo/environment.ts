import type { AppConfig } from '../config/index.js';

/**
 * Deterministic environment guardrails. The system prompt asks the model to be
 * careful, but a prompt is not a control: everything here is enforced in code
 * before a tool call reaches the browser.
 */
export type EnvironmentKind = 'production' | 'sandbox' | 'dev' | 'unknown';
export type DeclaredEnvironment = Exclude<EnvironmentKind, 'unknown'>;

// F&O hosts: <name>.operations[.<region>].dynamics.com (production),
// <name>.sandbox.operations[.<region>].dynamics.com (Tier-2+ sandbox), *.axcloud|cloudax.dynamics.com (dev VMs).
const PRODUCTION_HOST = /^[^.]+\.operations(\.[a-z]{2,5})?\.dynamics\.[a-z]{2,3}$/;
const SANDBOX_HOST = /^[^.]+\.sandbox\.operations(\.[a-z]{2,5})?\.dynamics\.[a-z]{2,3}$/;
const DEV_HOST = /\.(axcloud|cloudax)\.dynamics\.[a-z]{2,3}$/;

/** Microsoft sign-in hosts the browser is expected to visit during login. */
const SIGN_IN_HOSTS = ['login.microsoftonline.com', 'login.microsoft.com', 'login.live.com', '*.microsoftonline.com', '*.microsoftonline-p.com'];

type EnvCfg = Pick<AppConfig, 'D365_BASE_URL' | 'D365_COMPANY'> &
  Partial<Pick<AppConfig, 'AGENT_ALLOW_PRODUCTION' | 'AGENT_ALLOWED_HOSTS'>>;

function parseUrl(raw: string): URL | undefined {
  const s = raw.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    return undefined;
  }
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

export function hostOf(url: string | undefined): string | undefined {
  const parsed = url ? parseUrl(url) : undefined;
  return parsed ? normalizeHost(parsed.hostname) : undefined;
}

/**
 * The environment type. A value declared in D365_ENVIRONMENT_TYPE wins; otherwise it is guessed from the host,
 * which is only reliable for LCS-managed environments. Power Platform (unified) environments, sandbox or
 * production, use the same `<name>.operations.<geo>.dynamics.com` host, so the guess errs towards "production".
 */
export function classifyEnvironment(baseUrl: string | undefined, declared?: DeclaredEnvironment): EnvironmentKind {
  if (declared) return declared;
  const host = hostOf(baseUrl);
  if (!host) return 'unknown';
  if (SANDBOX_HOST.test(host)) return 'sandbox';
  if (PRODUCTION_HOST.test(host)) return 'production';
  if (DEV_HOST.test(host)) return 'dev';
  return 'unknown';
}

type ProductionCfg = Pick<AppConfig, 'D365_BASE_URL'> & Partial<Pick<AppConfig, 'AGENT_ALLOW_PRODUCTION' | 'D365_ENVIRONMENT_TYPE'>>;

/** Human-readable classification for `doctor`, saying whether it was declared or guessed. */
export function describeEnvironment(cfg: ProductionCfg): string {
  const kind = classifyEnvironment(cfg.D365_BASE_URL, cfg.D365_ENVIRONMENT_TYPE);
  return cfg.D365_ENVIRONMENT_TYPE ? `${kind}, declared` : kind === 'unknown' ? kind : `${kind}, guessed from the URL`;
}

/** A message when the configured environment is, or looks like, production and that was not explicitly allowed. */
export function productionIssue(cfg: ProductionCfg): string | undefined {
  if (classifyEnvironment(cfg.D365_BASE_URL, cfg.D365_ENVIRONMENT_TYPE) !== 'production' || cfg.AGENT_ALLOW_PRODUCTION) return undefined;
  const host = hostOf(cfg.D365_BASE_URL);
  const risk = 'The agent performs real UI actions (posting, deleting) and must not run against production.';
  if (cfg.D365_ENVIRONMENT_TYPE) {
    return `D365_ENVIRONMENT_TYPE is production (${host}). ${risk} Use a sandbox, or set AGENT_ALLOW_PRODUCTION=true only if you are certain.`;
  }
  return (
    `D365_BASE_URL (${host}) looks like a PRODUCTION F&O environment (no ".sandbox." in the host). ${risk} ` +
    'Power Platform (unified) sandboxes use the same host format, so if this is a sandbox or UAT environment, confirm it with D365_ENVIRONMENT_TYPE=sandbox. ' +
    'Set AGENT_ALLOW_PRODUCTION=true only for a real production run.'
  );
}

export function assertSafeEnvironment(cfg: ProductionCfg): void {
  const issue = productionIssue(cfg);
  if (issue) throw new Error(issue);
}

function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  return p.startsWith('*.') ? host === p.slice(2) || host.endsWith(p.slice(1)) : host === p;
}

/** Host patterns the browser may be told to navigate to. */
export function allowedHosts(cfg: Pick<AppConfig, 'D365_BASE_URL'> & Partial<Pick<AppConfig, 'AGENT_ALLOWED_HOSTS'>>): string[] {
  const base = hostOf(cfg.D365_BASE_URL);
  return [...(base ? [base] : []), ...SIGN_IN_HOSTS, ...(cfg.AGENT_ALLOWED_HOSTS ?? [])];
}

/**
 * Returns why a model-requested navigation must be refused, or undefined when it is fine.
 * Covers only navigations the model asks for; redirects the browser follows itself are not seen here.
 */
export function checkNavigation(cfg: EnvCfg, rawUrl: string, legalEntity: string | undefined = cfg.D365_COMPANY): string | undefined {
  if (rawUrl.trim().toLowerCase() === 'about:blank') return undefined;
  const url = parseUrl(rawUrl);
  if (!url) return `'${clip(rawUrl)}' is not a valid URL`;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return `navigation to ${url.protocol} URLs is not allowed`;
  const host = normalizeHost(url.hostname);
  if (!allowedHosts(cfg).some((p) => hostMatches(host, p))) {
    return `navigation to '${host}' is not allowed; only the configured F&O host and Microsoft sign-in pages are permitted`;
  }
  if (host === hostOf(cfg.D365_BASE_URL)) {
    const cmp = url.searchParams.get('cmp');
    if (cmp && legalEntity && cmp.toLowerCase() !== legalEntity.toLowerCase()) {
      return `the URL selects company '${cmp}', but this test is restricted to legal entity '${legalEntity}'`;
    }
  }
  return undefined;
}

function clip(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
