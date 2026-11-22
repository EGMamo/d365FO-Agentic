import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AppConfig } from '../config/index.js';
import type { TestCase, TestResult } from '../testing/types.js';
import { fetchWithResilience } from '../utils/http.js';
import { AzureCliTokenSource, azdoAuthMode, type AzRunner } from './auth.js';
import { decodeEntities } from './entities.js';
import { applyToSteps, mapSharedParameterData, mergeParameterValues, parseParameterData, renderDataSource, renderParameters, sharedParameterMapping, DATASOURCE_FIELD, PARAMETERS_FIELD, type ParameterData } from './parameters.js';
import { flattenSteps, parseStepsXml, type StepToken } from './steps.js';

/**
 * Azure DevOps REST client, signed in with a PAT or with the Azure CLI's Microsoft account (see auth.ts). Covers the minimal surface needed by
 * the agent MVP: enumerate test cases from a plan/suite, create test runs,
 * publish results, and attach artifacts.
 *
 * Note: kept intentionally simple. A future iteration may swap this for the
 * official Azure DevOps MCP server when `AZDO_USE_MCP=true`.
 */
export interface DevOpsPlan { id: string; name: string; state?: string; areaPath?: string; iteration?: string; rootSuiteId?: string }
export interface DevOpsSuite { id: string; name: string; type?: string; parentId?: string }

export class AzureDevOpsClient {
  private orgUrl: string;
  private project: string;
  private authHeader: () => Promise<string>;
  private usesPat: boolean;
  private apiVersion = '7.1';

  /** `az` runs the Azure CLI; tests pass a fake. */
  constructor(private cfg: AppConfig, az?: AzRunner) {
    if (!cfg.AZDO_ORG_URL || !cfg.AZDO_PROJECT) {
      throw new Error('Azure DevOps configuration is incomplete (organization URL and project are required)');
    }
    this.orgUrl = cfg.AZDO_ORG_URL.replace(/\/$/, '');
    this.project = cfg.AZDO_PROJECT;
    this.usesPat = azdoAuthMode(cfg) === 'pat';
    if (this.usesPat) {
      if (!cfg.AZDO_PAT) throw new Error('AZDO_AUTH=pat needs a personal access token (AZDO_PAT). Or clear it to sign in with your Microsoft account.');
      const basic = 'Basic ' + Buffer.from(`:${cfg.AZDO_PAT}`).toString('base64');
      this.authHeader = async () => basic;
    } else {
      const source = new AzureCliTokenSource(cfg.AZDO_TENANT_ID, az);
      this.authHeader = async () => `Bearer ${await source.token()}`;
    }
  }

  private url(path: string, orgLevel = false): string {
    return orgLevel ? `${this.orgUrl}${path}` : `${this.orgUrl}/${encodeURIComponent(this.project)}${path}`;
  }

  /** Who the agent is signed in as, and whether that account can open the project. One or two requests, nothing written. */
  async check(): Promise<{ ok: boolean; detail: string }> {
    try {
      const me = await this.request<{ authenticatedUser?: { providerDisplayName?: string; properties?: { Account?: { $value?: string } } } }>('/_apis/connectionData', { orgLevel: true });
      const user = me?.authenticatedUser;
      const name = user?.properties?.Account?.$value ?? user?.providerDisplayName;
      if (!name || /anonymous/i.test(user?.providerDisplayName ?? '')) return { ok: false, detail: 'Azure DevOps did not accept the sign-in.' };
      await this.request(`/_apis/projects/${encodeURIComponent(this.project)}?api-version=${this.apiVersion}`, { orgLevel: true });
      return { ok: true, detail: `signed in as ${name}, project ${this.project} found` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message.split('\n')[0].slice(0, 400) };
    }
  }

  private async request<T>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string>; orgLevel?: boolean }): Promise<T> {
    const res = await this.send(path, init);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** GETs every page of a list that Azure DevOps splits with the x-ms-continuationtoken header (at most `maxPages`). */
  private async pages<T>(path: string, maxPages = 20): Promise<T[]> {
    const all: T[] = [];
    let token: string | null = null;
    for (let i = 0; i < maxPages; i++) {
      const res = await this.send(token ? `${path}&continuationToken=${encodeURIComponent(token)}` : path);
      all.push(...(((await res.json()) as { value?: T[] }).value ?? []));
      token = res.headers.get('x-ms-continuationtoken');
      if (!token) break;
    }
    return all;
  }

  private async send(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string>; orgLevel?: boolean }): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: await this.authHeader(),
      accept: 'application/json',
      ...(init?.headers ?? {}),
    };
    let body: string | undefined;
    if (init?.body !== undefined) {
      // A caller can ask for another JSON type (work item updates are `application/json-patch+json`).
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const res = await fetchWithResilience(
      this.url(path, init?.orgLevel),
      { method: init?.method ?? 'GET', headers, body },
      {
        timeoutMs: this.cfg.AZDO_HTTP_TIMEOUT_MS,
        maxRetries: this.cfg.AZDO_HTTP_MAX_RETRIES,
        retryBaseMs: this.cfg.AZDO_HTTP_RETRY_BASE_MS,
      },
    );
    // A refused sign-in is a 401, or a 203 with the HTML sign-in page instead of JSON.
    if (res.status === 401 || res.status === 203) {
      throw new Error(
        this.usesPat
          ? `Azure DevOps refused the personal access token (${res.status}). Create a new one with Work Items (Read) and Test Management (Read & write), or clear it to sign in with your Microsoft account.`
          : `Azure DevOps refused your Microsoft account (${res.status}). Check that this account can open ${this.orgUrl}; if your account is in several Microsoft tenants, set AZDO_TENANT_ID to the one the organization belongs to and sign in again with \`d365fo-agent devops-login\`.`,
      );
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Azure DevOps ${res.status} ${res.statusText}: ${text}`);
    }
    return res;
  }

  /** The test plans of the project, newest first: what `run --plan` and the upload take. Read only. */
  async listPlans(): Promise<DevOpsPlan[]> {
    interface Plan { id: number; name: string; state?: string; areaPath?: string; iteration?: string; rootSuite?: { id: number } }
    const plans = await this.pages<Plan>(`/_apis/testplan/plans?includePlanDetails=true&api-version=${this.apiVersion}`);
    return plans
      .map((p) => ({ id: String(p.id), name: p.name, ...(p.state ? { state: p.state } : {}), ...(p.areaPath ? { areaPath: p.areaPath } : {}), ...(p.iteration ? { iteration: p.iteration } : {}), ...(p.rootSuite ? { rootSuiteId: String(p.rootSuite.id) } : {}) }))
      .sort((a, b) => Number(b.id) - Number(a.id));
  }

  /** The suites of one test plan, with the parent of each so the tree can be shown. Read only. */
  async listSuites(planId: string): Promise<DevOpsSuite[]> {
    interface Suite { id: number; name: string; suiteType?: string; parentSuite?: { id: number } }
    const suites = await this.pages<Suite>(`/_apis/testplan/Plans/${encodeURIComponent(planId)}/suites?api-version=${this.apiVersion}`);
    return suites.map((s) => ({ id: String(s.id), name: s.name, ...(s.suiteType ? { type: s.suiteType } : {}), ...(s.parentSuite ? { parentId: String(s.parentSuite.id) } : {}) }));
  }

  /**
   * Enumerate test cases from a Test Plan/Suite and normalize their steps into
   * our shared `TestCase` shape. Steps come back as XML in `Microsoft.VSTS.TCM.Steps`
   * which we parse leniently — a full XML parser is overkill for MVP.
   */
  async listTestCases(planId: string, suiteId: string): Promise<TestCase[]> {
    interface SuiteEntry {
      testCase: { id: string };
      workItem?: { id: number; name: string; workItemFields?: Array<Record<string, string>> };
    }
    const list = await this.request<{ value: SuiteEntry[] }>(
      `/_apis/test/Plans/${planId}/Suites/${suiteId}/testcases?api-version=${this.apiVersion}`,
    );

    const ids = list.value.map((v) => v.testCase.id).filter(Boolean);
    if (ids.length === 0) return [];

    interface WorkItem {
      id: number;
      rev?: number;
      fields: Record<string, unknown>;
      relations?: Array<{ rel?: string; url?: string }>;
    }
    // `$expand=relations` cannot be combined with `fields`, so every field comes back; the links to shared parameter sets are in the relations.
    const items = await this.request<{ value: WorkItem[] }>(
      `/_apis/wit/workitems?ids=${ids.join(',')}&$expand=relations&api-version=${this.apiVersion}`,
    );
    const shared = await this.sharedParameterSets(items.value);

    // Direct shared-step references are fetched together (at most 200 work items per request); nested references are
    // fetched on demand from the same cache. A missing item is a case problem, never a step to skip quietly.
    const sharedSteps = new Map<number, StepToken[]>();
    const failedSharedSteps = new Set<number>();
    const loadSharedSteps = async (ids: number[]): Promise<void> => {
      const missing = [...new Set(ids)].filter((id) => id > 0 && !sharedSteps.has(id) && !failedSharedSteps.has(id));
      for (let at = 0; at < missing.length; at += 200) {
        const batch = missing.slice(at, at + 200);
        try {
          const loaded = await this.request<{ value: Array<{ id: number; fields: Record<string, unknown> }> }>(
            `/_apis/wit/workitems?ids=${batch.join(',')}&fields=System.Id,Microsoft.VSTS.TCM.Steps&api-version=${this.apiVersion}`,
          );
          const found = new Set<number>();
          for (const wi of loaded.value) {
            found.add(wi.id);
            sharedSteps.set(wi.id, parseStepsXml(wi.fields['Microsoft.VSTS.TCM.Steps'] as string | undefined));
          }
          for (const id of batch) if (!found.has(id)) failedSharedSteps.add(id);
        } catch {
          for (const id of batch) failedSharedSteps.add(id);
        }
      }
    };
    const directRefs = (tokens: StepToken[]): number[] => tokens.flatMap((t) => t.kind === 'shared' ? [t.ref, ...directRefs(t.after)] : []);
    await loadSharedSteps(items.value.flatMap((wi) => directRefs(parseStepsXml(wi.fields['Microsoft.VSTS.TCM.Steps'] as string | undefined))));

    const out: TestCase[] = [];
    for (const wi of items.value) {
      const flattened = await flattenSteps(parseStepsXml(wi.fields['Microsoft.VSTS.TCM.Steps'] as string | undefined), async (id) => {
        await loadSharedSteps([id]);
        return sharedSteps.get(id);
      });
      const problems = [...flattened.problems];
      // The case's own "Parameter values" table, then each shared parameter set linked to it.
      const mapping = sharedParameterMapping(wi.fields);
      const linkedSets = [...new Set([...sharedIds(wi.relations), ...mapping.ids])];
      for (const id of linkedSets) if (!shared.has(id)) problems.push(`Shared parameter set ${id} could not be loaded from Azure DevOps; check that it exists and that your Azure DevOps credentials can read it.`);
      const sources: ParameterData[] = [
        parseParameterData(wi.fields),
        ...linkedSets.flatMap((id) => (shared.get(id) ?? []).map((data) => mapSharedParameterData(data, mapping, id))),
      ];
      const sourceSteps = flattened.steps.length ? flattened.steps : parseTestSteps((wi.fields['Microsoft.VSTS.TCM.Steps'] as string) ?? '');
      const applied = applyToSteps(sourceSteps, sources);
      // Keep the Stage 1 public step shape stable; full ADO metadata remains on sourceSteps and is used at publish time.
      const steps = applied.steps.map((s) => ({ index: s.index, action: s.action, ...(s.expected !== undefined ? { expected: s.expected } : {}) }));
      const summary = applied.summary;
      const tags = ((wi.fields['System.Tags'] as string) ?? '')
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean);
      out.push({
        id: String(wi.id),
        source: 'devops',
        title: String(wi.fields['System.Title'] ?? `Test case ${wi.id}`),
        area: wi.fields['System.AreaPath'] as string | undefined,
        priority: wi.fields['Microsoft.VSTS.Common.Priority'] as number | undefined,
        tags,
        steps,
        sourceSteps,
        parameterData: sources,
        rev: typeof wi.rev === 'number' ? wi.rev : undefined,
        url: `${this.orgUrl}/${encodeURIComponent(this.project)}/_workitems/edit/${wi.id}`,
        ...(summary ? { parameters: summary } : {}),
        ...(problems.length ? { problems: [...new Set(problems)] } : {}),
      });
    }
    return out;
  }

  /**
   * Saves values into a test case's own "Parameter values" table (first row), for parameters that have no value yet.
   * A name that already has a value is left alone. The change is checked by reading the case back; if the stored data
   * is not what was written, the case is put back as it was and an error says so.
   */
  async saveParameterValues(caseId: string, values: Record<string, string>): Promise<{ saved: string[]; skipped: string[] }> {
    if (!/^\d+$/.test(caseId)) throw new Error(`'${caseId}' is not a test case id.`);
    for (const name of Object.keys(values)) if (!/^[A-Za-z_]\w{0,60}$/.test(name)) throw new Error(`'${name}' is not a parameter name.`);
    const path = `/_apis/wit/workitems/${caseId}?fields=System.Rev,${PARAMETERS_FIELD},${DATASOURCE_FIELD}&api-version=${this.apiVersion}`;
    const before = await this.request<{ rev?: number; fields: Record<string, unknown> }>(path);
    const { data, saved, skipped } = mergeParameterValues(parseParameterData(before.fields), values);
    if (!saved.length) return { saved, skipped };

    const patch = (fields: Record<string, string | undefined>, rev?: number) => [
      ...(rev === undefined ? [] : [{ op: 'test', path: '/rev', value: rev }]),
      ...Object.entries(fields).map(([k, v]) => (v === undefined ? { op: 'remove', path: `/fields/${k}` } : { op: 'add', path: `/fields/${k}`, value: v })),
    ];
    const write = (fields: Record<string, string | undefined>, rev?: number) =>
      this.request(`/_apis/wit/workitems/${caseId}?api-version=${this.apiVersion}`, { method: 'PATCH', headers: { 'content-type': 'application/json-patch+json' }, body: patch(fields, rev) });
    await write({ [PARAMETERS_FIELD]: renderParameters(data.names), [DATASOURCE_FIELD]: renderDataSource(data.names, data.rows) }, before.rev);

    const after = parseParameterData((await this.request<{ fields: Record<string, unknown> }>(path)).fields);
    const intact = saved.every((n) => after.rows[0]?.[n] === data.rows[0][n]) && data.names.every((n) => after.names.includes(n))
      && existingRowsKept(parseParameterData(before.fields), after);
    if (!intact) {
      const original = (k: string): string | undefined => (typeof before.fields[k] === 'string' ? (before.fields[k] as string) : undefined);
      await write({ [PARAMETERS_FIELD]: original(PARAMETERS_FIELD), [DATASOURCE_FIELD]: original(DATASOURCE_FIELD) });
      throw new Error(`Azure DevOps stored the parameter values differently from what was sent, so test case ${caseId} was put back as it was. Nothing was saved.`);
    }
    return { saved, skipped };
  }

  /** The parameter data of the shared parameter sets the cases link to, by work item id. A set that cannot be read leaves its names without values. */
  private async sharedParameterSets(items: Array<{ fields: Record<string, unknown>; relations?: Array<{ rel?: string; url?: string }> }>): Promise<Map<number, ParameterData[]>> {
    const wanted = [...new Set(items.flatMap((wi) => [...sharedIds(wi.relations), ...sharedParameterMapping(wi.fields).ids]))];
    const out = new Map<number, ParameterData[]>();
    if (!wanted.length) return out;
    try {
      for (let at = 0; at < wanted.length; at += 200) {
        const batch = wanted.slice(at, at + 200);
        const sets = await this.request<{ value: Array<{ id: number; fields: Record<string, unknown> }> }>(
          `/_apis/wit/workitems?ids=${batch.join(',')}&fields=System.Id,${PARAMETERS_FIELD},${DATASOURCE_FIELD}&api-version=${this.apiVersion}`,
        );
        for (const s of sets.value) out.set(s.id, [parseParameterData(s.fields)]);
      }
    } catch (e) {
      console.warn(`warning: could not read the shared parameter sets (${(e as Error).message.split('\n')[0].slice(0, 200)}); their parameters stay unfilled and affected cases are blocked.`);
    }
    return out;
  }

  /**
   * Creates a test run in the configured Test Plan, publishes per-case results,
   * uploads any artifacts as attachments, and marks the run complete.
   */
  async publishResults(planId: string, all: TestResult[]): Promise<{ runId: number; url: string }> {
    // A case stopped by Ctrl+C has no verdict, so it is never published.
    const results = all.filter((r) => !r.interrupted);
    if (!results.length) throw new Error('Nothing to upload: no case finished before the run was interrupted.');
    const startedDate = results[0]?.startedAt ?? new Date().toISOString();
    const completedDate = results.at(-1)?.finishedAt ?? new Date().toISOString();
    const run = await this.request<{ id: number; url: string }>(
      `/_apis/test/runs?api-version=${this.apiVersion}`,
      {
        method: 'POST',
        body: {
          name: `d365fo-agentic run ${new Date().toISOString()}`,
          plan: { id: planId },
          automated: true,
          startedDate,
          state: 'InProgress',
        },
      },
    );

    const outcomeMap: Record<string, string> = {
      passed: 'Passed',
      failed: 'Failed',
      blocked: 'Blocked',
      skipped: 'NotExecuted',
    };
    // One ADO result per case, with data rows as iterations rather than duplicate independent case results.
    const groups: TestResult[][] = [];
    const byCase = new Map<string, TestResult[]>();
    for (const result of results) {
      const group = byCase.get(result.testCaseId);
      if (group) group.push(result);
      else { const next = [result]; byCase.set(result.testCaseId, next); groups.push(next); }
    }
    const payload = groups.map((rows) => {
      const first = rows[0];
      return {
        testCaseTitle: first.title,
        automatedTestName: first.title,
        outcome: outcomeMap[worstOutcome(rows)] ?? 'Failed',
        state: 'Completed',
        startedDate: rows.map((r) => r.startedAt).sort()[0],
        completedDate: rows.map((r) => r.finishedAt).sort().at(-1),
        durationInMs: rows.reduce((n, r) => n + r.durationMs, 0),
        errorMessage: rows.flatMap((r) => r.errorMessage ? [`${rows.length > 1 ? `Row ${r.iteration?.row ?? 1}: ` : ''}${r.errorMessage}`] : []).join('\n').slice(0, 2000) || undefined,
        testCase: /^\d+$/.test(first.testCaseId) ? { id: first.testCaseId } : undefined,
      };
    });

    const created = await this.request<{ value: Array<{ id: number }> }>(
      `/_apis/test/Runs/${run.id}/results?api-version=${this.apiVersion}`,
      { method: 'POST', body: payload },
    );

    const updates = groups.flatMap((rows, i) => {
      const id = created.value[i]?.id;
      if (!id || (rows.length === 1 && !rows[0].steps.some((s) => s.actionPath))) return [];
      return [{
        id,
        state: 'Completed',
        outcome: outcomeMap[worstOutcome(rows)] ?? 'Failed',
        iterationDetails: rows.map((r) => {
          const iterationId = r.iteration?.row ?? 1;
          return {
            id: iterationId,
            outcome: outcomeMap[r.outcome] ?? 'Failed',
            startedDate: r.startedAt,
            completedDate: r.finishedAt,
            durationInMs: r.durationMs,
            errorMessage: r.errorMessage,
            actionResults: r.steps.map((s) => ({
              actionPath: s.actionPath ?? hexActionPath(s.index),
              iterationId,
              outcome: outcomeMap[s.status] ?? 'NotExecuted',
              errorMessage: s.errorMessage,
              comment: s.observed,
            })),
          };
        }),
      }];
    });
    if (updates.length) {
      try {
        await this.request(`/_apis/test/Runs/${run.id}/results?api-version=${this.apiVersion}`, { method: 'PATCH', body: updates });
      } catch (e) {
        // Older/on-prem APIs can reject iteration/action details. Keep the case-level rollup and attachments.
        console.warn(`Azure DevOps rejected iteration details; uploading case-level outcomes instead: ${(e as Error).message.split('\n')[0].slice(0, 200)}`);
        await this.request(`/_apis/test/Runs/${run.id}/results?api-version=${this.apiVersion}`, {
          method: 'PATCH', body: updates.map(({ iterationDetails: _details, ...caseLevel }) => caseLevel),
        });
      }
    }

    for (let i = 0; i < groups.length; i++) {
      const resultId = created.value[i]?.id;
      if (!resultId) continue;
      for (const artifact of [...new Set(groups[i].flatMap((r) => r.artifacts))]) {
        try {
          await this.attachToResult(run.id, resultId, artifact);
        } catch (e) {
          console.warn(`Failed to attach ${artifact}: ${(e as Error).message}`);
        }
      }
    }

    await this.request(`/_apis/test/runs/${run.id}?api-version=${this.apiVersion}`, {
      method: 'PATCH',
      body: { state: 'Completed', completedDate },
    });

    return { runId: run.id, url: `${this.orgUrl}/${encodeURIComponent(this.project)}/_testManagement/runs?runId=${run.id}` };
  }

  private async attachToResult(runId: number, resultId: number, filePath: string): Promise<void> {
    const data = await readFile(filePath);
    await this.request(
      `/_apis/test/Runs/${runId}/Results/${resultId}/attachments?api-version=${this.apiVersion}-preview.1`,
      {
        method: 'POST',
        body: {
          stream: data.toString('base64'),
          fileName: basename(filePath),
          comment: 'd365fo-agentic artifact',
          attachmentType: 'GeneralAttachment',
        },
      },
    );
  }
}

export function worstOutcome(rows: TestResult[]): TestResult['outcome'] {
  if (rows.some((r) => r.outcome === 'failed')) return 'failed';
  if (rows.some((r) => r.outcome === 'blocked')) return 'blocked';
  if (rows.every((r) => r.outcome === 'skipped')) return 'skipped';
  return 'passed';
}

const hexActionPath = (index: number): string => Math.max(0, index).toString(16).padStart(8, '0');

/**
 * Very lenient parser for DevOps Test Case Steps XML. Falls back to plain-text
 * splitting when the field isn't XML (e.g. a manual export). Good enough for
 * MVP; can be replaced with an XML parser later.
 */
export { decodeEntities };

/** Every value that was in the case's table is still there after a save. */
function existingRowsKept(before: ParameterData, after: ParameterData): boolean {
  return before.rows.every((row, i) => Object.entries(row).every(([k, v]) => !v.trim() || after.rows[i]?.[k] === v));
}

/** Work item ids of the shared parameter sets a test case links to (any link type whose name says "SharedParameter"). */
function sharedIds(relations: Array<{ rel?: string; url?: string }> | undefined): number[] {
  return (relations ?? [])
    .filter((r) => /SharedParameter/i.test(r.rel ?? ''))
    .map((r) => Number(/\/workitems\/(\d+)$/i.exec(r.url ?? '')?.[1]))
    .filter((id) => Number.isInteger(id) && id > 0);
}

export function parseTestSteps(xml: string): { index: number; action: string; expected?: string }[] {
  if (!xml || xml.trim() === '') return [];
  const stepRe = /<step[^>]*id="(\d+)"[^>]*>([\s\S]*?)<\/step>/gi;
  const paramRe = /<parameterizedString([^>]*)>([\s\S]*?)<\/parameterizedString>/gi;
  const stripTags = (s: string) => {
    let prev = s;
    // Loop until stable so we never leave partial tag fragments behind
    // (single-pass replacement is vulnerable to nested/broken tags).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const next = prev.replace(/<[^>]*>/g, '');
      if (next === prev) break;
      prev = next;
    }
    return prev;
  };
  // A formatted step is HTML stored XML-escaped (`&lt;P&gt;Group: TBC -&amp;nbsp;supplier group&lt;/P&gt;`): unescape
  // the XML, drop the HTML tags, then decode the HTML text. Text a person typed as `<vendor group>` is still escaped
  // after the first pass, so it survives the tag stripping. A plain step is only XML-escaped: never strip its tags.
  const text = (attrs: string, raw: string): string => {
    const formatted = /isformatted\s*=\s*"true"/i.test(attrs);
    const xml = decodeEntities(raw);
    const plain = formatted ? decodeEntities(stripTags(xml.replace(/<br\s*\/?>|<\/(?:p|div|li)>/gi, '\n'))) : xml;
    return plain.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  };
  const steps: { index: number; action: string; expected?: string }[] = [];
  let m: RegExpExecArray | null;
  let i = 1;
  while ((m = stepRe.exec(xml)) !== null) {
    const inner = m[2];
    const params: string[] = [];
    let p: RegExpExecArray | null;
    while ((p = paramRe.exec(inner)) !== null) params.push(text(p[1], p[2]));
    steps.push({ index: i++, action: params[0] ?? '', expected: params[1] });
  }
  if (steps.length > 0) return steps;
  // Fallback: split by lines.
  return xml
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((action, idx) => ({ index: idx + 1, action }));
}
