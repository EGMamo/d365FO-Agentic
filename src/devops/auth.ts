import { spawn } from 'node:child_process';
import type { AppConfig } from '../config/index.js';

/**
 * How the agent signs in to Azure DevOps: a personal access token, or the Microsoft work account the
 * Azure CLI is signed in with (`az login`), so no token has to be created, stored or renewed.
 */
export type AzdoAuthMode = 'pat' | 'azure-cli';

/** The Azure DevOps resource id: what an Entra access token for Azure DevOps is issued for. */
export const AZDO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

/** The command that installs the Azure CLI on Windows, shown when it is missing. */
export const AZ_INSTALL_HINT = 'Install the Azure CLI (Windows: `winget install -e --id Microsoft.AzureCLI`, then reopen the app)';

/** A tenant id or domain, checked before it is passed to `az` (which runs through a shell on Windows). */
const TENANT = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

/** `AZDO_AUTH` when set; otherwise the token when there is one, else the Azure CLI sign-in. */
export function azdoAuthMode(cfg: Pick<AppConfig, 'AZDO_AUTH' | 'AZDO_PAT'>): AzdoAuthMode {
  if (cfg.AZDO_AUTH) return cfg.AZDO_AUTH;
  return cfg.AZDO_PAT ? 'pat' : 'azure-cli';
}

export interface AzResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** `az` could not be started: the Azure CLI is not installed or not on PATH. */
  missing?: boolean;
}

export type AzRunner = (args: string[], opts?: { interactive?: boolean; timeoutMs?: number }) => Promise<AzResult>;

/** Runs `az`. On Windows it is `az.cmd`, which only starts through a shell; every argument is fixed or validated. */
export const runAz: AzRunner = (args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn('az', args, {
      shell: process.platform === 'win32',
      stdio: opts.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: !opts.interactive,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : undefined;
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: e.message, missing: e.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      // Through a shell, a missing command is the shell's "not recognized" / "not found" message instead of ENOENT.
      const missing = code !== 0 && /is not recognized as an internal or external command|az: (command )?not found/i.test(stderr);
      resolve({ code, stdout, stderr, ...(missing ? { missing: true } : {}) });
    });
  });

function tenantArgs(tenant: string | undefined): string[] {
  if (!tenant) return [];
  if (!TENANT.test(tenant)) throw new Error(`AZDO_TENANT_ID '${tenant}' is not a tenant id or domain.`);
  return ['--tenant', tenant];
}

/** Plain-words reason the Azure CLI could not give a token, with what to do about it. */
export function azTokenProblem(res: AzResult): string {
  if (res.missing) return `The Azure CLI is not installed, so the agent cannot sign in to Azure DevOps with your Microsoft account. ${AZ_INSTALL_HINT}, then sign in (the "Sign in to Azure DevOps" button in the settings app, or \`d365fo-agent devops-login\`). Or use a personal access token (AZDO_PAT).`;
  const err = res.stderr.trim();
  if (/az login|not logged in|no subscription|AADSTS50173|AADSTS70043|AADSTS700082|refresh token has expired|interaction_required/i.test(err)) {
    return 'You are not signed in to Azure DevOps (or the sign-in expired). Sign in with `d365fo-agent devops-login`, or the "Sign in to Azure DevOps" button in the settings app.';
  }
  return `The Azure CLI could not get an Azure DevOps token: ${err.split('\n').find((l) => l.trim())?.trim() ?? `exit code ${res.code}`}`;
}

/**
 * Bearer tokens for Azure DevOps from the Azure CLI's sign-in, kept until a few minutes before they expire
 * (they last about an hour), so a run asks `az` once rather than per request.
 */
export class AzureCliTokenSource {
  private cached?: { token: string; expiresAt: number };

  constructor(private tenant?: string, private az: AzRunner = runAz, private now: () => number = Date.now) {}

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - this.now() > 5 * 60_000) return this.cached.token;
    const res = await this.az(['account', 'get-access-token', '--resource', AZDO_RESOURCE, '--output', 'json', ...tenantArgs(this.tenant)], { timeoutMs: 60_000 });
    if (res.code !== 0) throw new Error(azTokenProblem(res));
    let parsed: { accessToken?: unknown; expires_on?: unknown; expiresOn?: unknown };
    try {
      parsed = JSON.parse(res.stdout) as typeof parsed;
    } catch {
      throw new Error('The Azure CLI returned something that is not a token. Update it with `az upgrade`.');
    }
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) throw new Error('The Azure CLI returned no access token. Sign in again with `d365fo-agent devops-login`.');
    // `expires_on` (epoch seconds) is in newer versions; `expiresOn` is local time without a zone in all of them.
    const epoch = Number(parsed.expires_on);
    const local = typeof parsed.expiresOn === 'string' ? Date.parse(parsed.expiresOn.replace(' ', 'T')) : NaN;
    const expiresAt = Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : Number.isFinite(local) ? local : this.now() + 30 * 60_000;
    this.cached = { token: parsed.accessToken, expiresAt };
    return parsed.accessToken;
  }
}

/** Opens the Microsoft sign-in in the browser through `az login`. Works for accounts without an Azure subscription. */
export async function azLogin(tenant?: string, az: AzRunner = runAz): Promise<AzResult> {
  return az(['login', '--allow-no-subscriptions', '--output', 'none', ...tenantArgs(tenant)], { interactive: true });
}
