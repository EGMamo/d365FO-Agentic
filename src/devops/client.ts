import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AppConfig } from '../config/index.js';
import type { TestCase, TestResult } from '../testing/types.js';
import { fetchWithResilience } from '../utils/http.js';

/**
 * Azure DevOps REST client (PAT-based). Covers the minimal surface needed by
 * the agent MVP: enumerate test cases from a plan/suite, create test runs,
 * publish results, and attach artifacts.
 *
 * Note: kept intentionally simple. A future iteration may swap this for the
 * official Azure DevOps MCP server when `AZDO_USE_MCP=true`.
 */
export class AzureDevOpsClient {
  private orgUrl: string;
  private project: string;
  private authHeader: string;
  private apiVersion = '7.1';

  constructor(private cfg: AppConfig) {
    if (!cfg.AZDO_ORG_URL || !cfg.AZDO_PROJECT || !cfg.AZDO_PAT) {
      throw new Error('Azure DevOps configuration is incomplete (org URL, project, PAT required)');
    }
    this.orgUrl = cfg.AZDO_ORG_URL.replace(/\/$/, '');
    this.project = cfg.AZDO_PROJECT;
    this.authHeader = 'Basic ' + Buffer.from(`:${cfg.AZDO_PAT}`).toString('base64');
  }

  private url(path: string): string {
    return `${this.orgUrl}/${encodeURIComponent(this.project)}${path}`;
  }

  private async request<T>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T> {
    const headers: Record<string, string> = {
      authorization: this.authHeader,
      accept: 'application/json',
      ...(init?.headers ?? {}),
    };
    let body: string | undefined;
    if (init?.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const res = await fetchWithResilience(
      this.url(path),
      { method: init?.method ?? 'GET', headers, body },
      {
        timeoutMs: this.cfg.AZDO_HTTP_TIMEOUT_MS,
        maxRetries: this.cfg.AZDO_HTTP_MAX_RETRIES,
        retryBaseMs: this.cfg.AZDO_HTTP_RETRY_BASE_MS,
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Azure DevOps ${res.status} ${res.statusText}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
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
      fields: Record<string, unknown>;
    }
    const items = await this.request<{ value: WorkItem[] }>(
      `/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.AreaPath,System.Tags,Microsoft.VSTS.Common.Priority,Microsoft.VSTS.TCM.Steps&api-version=${this.apiVersion}`,
    );

    return items.value.map((wi) => {
      const stepsXml = (wi.fields['Microsoft.VSTS.TCM.Steps'] as string) ?? '';
      const steps = parseTestSteps(stepsXml);
      const tags = ((wi.fields['System.Tags'] as string) ?? '')
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean);
      return {
        id: String(wi.id),
        source: 'devops',
        title: String(wi.fields['System.Title'] ?? `Test case ${wi.id}`),
        area: wi.fields['System.AreaPath'] as string | undefined,
        priority: wi.fields['Microsoft.VSTS.Common.Priority'] as number | undefined,
        tags,
        steps,
      } satisfies TestCase;
    });
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
    const payload = results.map((r) => ({
      testCaseTitle: r.title,
      automatedTestName: r.title,
      outcome: outcomeMap[r.outcome] ?? 'Failed',
      state: 'Completed',
      startedDate: r.startedAt,
      completedDate: r.finishedAt,
      durationInMs: r.durationMs,
      errorMessage: r.errorMessage,
      testCase: /^\d+$/.test(r.testCaseId) ? { id: r.testCaseId } : undefined,
    }));

    const created = await this.request<{ value: Array<{ id: number }> }>(
      `/_apis/test/Runs/${run.id}/results?api-version=${this.apiVersion}`,
      { method: 'POST', body: payload },
    );

    for (let i = 0; i < results.length; i++) {
      const resultId = created.value[i]?.id;
      if (!resultId) continue;
      for (const artifact of results[i].artifacts) {
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

/**
 * Very lenient parser for DevOps Test Case Steps XML. Falls back to plain-text
 * splitting when the field isn't XML (e.g. a manual export). Good enough for
 * MVP; can be replaced with an XML parser later.
 */
export function parseTestSteps(xml: string): { index: number; action: string; expected?: string }[] {
  if (!xml || xml.trim() === '') return [];
  const stepRe = /<step[^>]*id="(\d+)"[^>]*>([\s\S]*?)<\/step>/gi;
  const paramRe = /<parameterizedString[^>]*>([\s\S]*?)<\/parameterizedString>/gi;
  const stripHtml = (s: string) => {
    let prev = s;
    // Loop until stable so we never leave partial tag fragments behind
    // (single-pass replacement is vulnerable to nested/broken tags).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const next = prev.replace(/<[^>]*>/g, '');
      if (next === prev) break;
      prev = next;
    }
    return prev.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
  };
  const steps: { index: number; action: string; expected?: string }[] = [];
  let m: RegExpExecArray | null;
  let i = 1;
  while ((m = stepRe.exec(xml)) !== null) {
    const inner = m[2];
    const params: string[] = [];
    let p: RegExpExecArray | null;
    while ((p = paramRe.exec(inner)) !== null) params.push(stripHtml(p[1]));
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
