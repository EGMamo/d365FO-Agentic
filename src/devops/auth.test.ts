import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { AZDO_RESOURCE, AzureCliTokenSource, azdoAuthMode, azLogin, azTokenProblem, type AzRunner } from './auth.js';
import { AzureDevOpsClient } from './client.js';
import type { AppConfig } from '../config/index.js';

const token = (accessToken: string, expiresOn: number): string => JSON.stringify({ accessToken, expires_on: Math.floor(expiresOn / 1000), expiresOn: '2026-10-16 12:00:00.000000' });

describe('Azure DevOps sign-in mode', () => {
  it('uses the token when one is set, otherwise the Azure CLI, unless AZDO_AUTH says which', () => {
    assert.equal(azdoAuthMode({ AZDO_PAT: 'x' }), 'pat');
    assert.equal(azdoAuthMode({}), 'azure-cli');
    assert.equal(azdoAuthMode({ AZDO_PAT: 'x', AZDO_AUTH: 'azure-cli' }), 'azure-cli');
  });
});

describe('Azure CLI tokens', () => {
  it('asks az for an Azure DevOps token once and reuses it until shortly before it expires', async () => {
    let now = 1_000_000_000_000;
    const calls: string[][] = [];
    const az: AzRunner = async (args) => { calls.push(args); return { code: 0, stdout: token(`t${calls.length}`, now + 60 * 60_000), stderr: '' }; };
    const source = new AzureCliTokenSource('contoso.onmicrosoft.com', az, () => now);
    assert.equal(await source.token(), 't1');
    assert.equal(await source.token(), 't1');
    assert.deepEqual(calls[0], ['account', 'get-access-token', '--resource', AZDO_RESOURCE, '--output', 'json', '--tenant', 'contoso.onmicrosoft.com']);
    now += 56 * 60_000;
    assert.equal(await source.token(), 't2');
  });

  it('explains a missing Azure CLI and a missing sign-in in plain words', async () => {
    assert.match(azTokenProblem({ code: null, stdout: '', stderr: 'spawn az ENOENT', missing: true }), /Azure CLI is not installed[\s\S]*winget install/);
    assert.match(azTokenProblem({ code: 1, stdout: '', stderr: "ERROR: Please run 'az login' to setup account." }), /not signed in[\s\S]*devops-login/);
    const az: AzRunner = async () => ({ code: 1, stdout: '', stderr: "ERROR: Please run 'az login' to setup account." });
    await assert.rejects(new AzureCliTokenSource(undefined, az).token(), /not signed in/);
  });

  it('refuses a tenant value that is not an id or domain, before running az', async () => {
    let ran = false;
    const az: AzRunner = async () => { ran = true; return { code: 0, stdout: '', stderr: '' }; };
    await assert.rejects(azLogin('x & calc', az), /not a tenant id or domain/);
    assert.equal(ran, false);
  });

  it('signs in through az login without needing an Azure subscription', async () => {
    let seen: string[] = [];
    const az: AzRunner = async (args, opts) => { seen = args; assert.equal(opts?.interactive, true); return { code: 0, stdout: '', stderr: '' }; };
    await azLogin(undefined, az);
    assert.deepEqual(seen, ['login', '--allow-no-subscriptions', '--output', 'none']);
  });
});

describe('Azure DevOps client sign-in', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const cfg = { AZDO_ORG_URL: 'https://dev.azure.com/contoso', AZDO_PROJECT: 'Fin Ops', AZDO_HTTP_TIMEOUT_MS: 5000, AZDO_HTTP_MAX_RETRIES: 0, AZDO_HTTP_RETRY_BASE_MS: 1 } as AppConfig;

  it('sends the Azure CLI token as a bearer token when no PAT is set, and reports who is signed in', async () => {
    const seen: Array<{ url: string; auth: string }> = [];
    globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, auth: init.headers.authorization });
      const body = url.includes('connectionData') ? { authenticatedUser: { providerDisplayName: 'Mahmoud', properties: { Account: { $value: 'm@contoso.com' } } } } : { id: 'p' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const az: AzRunner = async () => ({ code: 0, stdout: token('abc', Date.now() + 3600_000), stderr: '' });
    const check = await new AzureDevOpsClient(cfg, az).check();
    assert.deepEqual(check, { ok: true, detail: 'signed in as m@contoso.com, project Fin Ops found' });
    assert.equal(seen[0].url, 'https://dev.azure.com/contoso/_apis/connectionData');
    assert.equal(seen[0].auth, 'Bearer abc');
    assert.equal(seen[1].url, 'https://dev.azure.com/contoso/_apis/projects/Fin%20Ops?api-version=7.1');
  });

  it('turns the sign-in page Azure DevOps returns for a refused account into a clear message', async () => {
    globalThis.fetch = (async () => new Response('<html>Sign in</html>', { status: 203 })) as unknown as typeof fetch;
    const check = await new AzureDevOpsClient({ ...cfg, AZDO_PAT: 'old' }).check();
    assert.equal(check.ok, false);
    assert.match(check.detail, /refused the personal access token \(203\)/);
  });
});
