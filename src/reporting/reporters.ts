import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestResult } from '../testing/types.js';
import { FAILURE_CATEGORY_HINTS, summarizeFailures, type FailureCategory } from '../testing/triage.js';

/**
 * Writes JSON, JUnit XML, and a self-contained HTML report to `dir`. Returns
 * the absolute paths so callers can attach or link them.
 */
export async function writeReports(dir: string, results: TestResult[]): Promise<{ json: string; junit: string; html: string }> {
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, 'results.json');
  const junitPath = join(dir, 'results.junit.xml');
  const htmlPath = join(dir, 'report.html');
  await Promise.all([
    writeFile(jsonPath, JSON.stringify(results, null, 2)),
    writeFile(junitPath, toJUnit(results)),
    writeFile(htmlPath, toHtml(results)),
  ]);
  return { json: jsonPath, junit: junitPath, html: htmlPath };
}

/** Hint for a category; empty for one this version does not know (a results file from elsewhere or edited by hand). */
function categoryHint(c: string): string {
  return FAILURE_CATEGORY_HINTS[c as FailureCategory] ?? '';
}

function xmlEscape(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toJUnit(results: TestResult[]): string {
  const total = results.length;
  const failures = results.filter((r) => r.outcome === 'failed').length;
  // Blocked means the case could not be judged (sign-in, missing page, budget): JUnit's <error>, so CI does not
  // read it as a harmless skip. A case stopped by Ctrl+C was simply not run to the end and stays <skipped>.
  const isError = (r: TestResult): boolean => r.outcome === 'blocked' && !r.interrupted;
  const errors = results.filter(isError).length;
  const skipped = results.filter((r) => r.outcome === 'skipped' || (r.outcome === 'blocked' && r.interrupted)).length;
  const timeSec = (results.reduce((s, r) => s + r.durationMs, 0) / 1000).toFixed(3);
  const cases = results
    .map((r) => {
      const t = (r.durationMs / 1000).toFixed(3);
      const retryMeta = `attemptCount=${r.attemptCount ?? 1}; firstOutcome=${r.firstOutcome ?? r.outcome}; previousOutcome=${r.previousOutcome ?? 'n/a'}; finalOutcome=${r.outcome}${r.failureCategory ? `; category=${r.failureCategory}` : ''}${r.policyBlocks?.length ? `; guardrailBlocks=${r.policyBlocks.length}` : ''}${r.timeouts?.length ? `; timeouts=${r.timeouts.length}` : ''}${r.replay ? `; replay=${r.replay.outcome}${r.replay.step ? ` at step ${r.replay.step}` : ''}` : ''}`;
      let body = '';
      if (r.outcome === 'failed') {
        body = `<failure message="${xmlEscape(r.errorMessage ?? 'failed')}"${r.failureCategory ? ` type="${xmlEscape(r.failureCategory)}"` : ''}>${xmlEscape(r.errorMessage ?? '')}</failure><system-out>${xmlEscape(
          retryMeta,
        )}</system-out>`;
      } else if (isError(r)) {
        body = `<error message="${xmlEscape(`blocked: ${r.errorMessage ?? ''}`)}"${r.failureCategory ? ` type="${xmlEscape(r.failureCategory)}"` : ''}>${xmlEscape(r.errorMessage ?? '')}</error><system-out>${xmlEscape(retryMeta)}</system-out>`;
      } else if (r.outcome === 'skipped' || r.outcome === 'blocked') {
        body = `${r.outcome === 'blocked' ? `<skipped message="${xmlEscape(`blocked${r.failureCategory ? ` (${r.failureCategory})` : ''}: ${r.errorMessage ?? ''}`)}"/>` : '<skipped/>'}<system-out>${xmlEscape(retryMeta)}</system-out>`;
      } else {
        body = `<system-out>${xmlEscape(retryMeta)}</system-out>`;
      }
      return `<testcase classname="d365fo-agentic" name="${xmlEscape(r.title)}" time="${t}">${body}</testcase>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="d365fo-agentic" tests="${total}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${timeSec}">
${cases}
</testsuite>`;
}

function toHtml(results: TestResult[]): string {
  const rows = results
    .map(
      (r) => `
<tr class="row ${r.outcome}">
  <td>${xmlEscape(r.testCaseId)}</td>
  <td>${xmlEscape(r.title)}</td>
  <td><span class="badge ${xmlEscape(r.outcome)}">${xmlEscape(r.outcome)}</span></td>
  <td>${r.failureCategory ? `<span class="cat" title="${xmlEscape(categoryHint(r.failureCategory))}">${xmlEscape(r.failureCategory)}</span>` : ''}</td>
  <td>${r.attemptCount ?? 1}</td>
  <td>${xmlEscape(`${r.firstOutcome ?? r.outcome} → ${r.outcome}`)}</td>
  <td>${(r.durationMs / 1000).toFixed(2)}s</td>
  <td>${r.steps.length}</td>
  <td>${r.replay?.outcome === 'passed' ? '<div class="data">Replayed from the last passing run, without the AI.</div>' : ''}${
    r.replay?.outcome === 'failed' ? `<div class="data">Replay of the last passing run failed at step ${r.replay.step}, so the AI ran it: ${xmlEscape(r.replay.error ?? '')}</div>` : ''
  }${r.errorMessage ? xmlEscape(r.errorMessage) : ''}${
    r.policyBlocks?.length ? `<div class="guard">Guardrails refused ${r.policyBlocks.length} call(s):<br>${r.policyBlocks.map(xmlEscape).join('<br>')}</div>` : ''
  }${r.timeouts?.length ? `<div class="guard">Timed out ${r.timeouts.length} time(s):<br>${r.timeouts.map(xmlEscape).join('<br>')}</div>` : ''}${
    r.steps.some((st) => st.verified === false) ? `<div class="guard">Unverified step(s): ${r.steps.filter((st) => st.verified === false).map((st) => st.index).join(', ')}</div>` : ''
  }${
    r.data && Object.keys(r.data).length ? `<div class="data">Recorded values:<br>${Object.entries(r.data).map(([k, v]) => `${xmlEscape(k)} = ${xmlEscape(v)}`).join('<br>')}</div>` : ''
  }</td>
</tr>`,
    )
    .join('');
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.outcome === 'passed').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
    blocked: results.filter((r) => r.outcome === 'blocked').length,
    skipped: results.filter((r) => r.outcome === 'skipped').length,
    firstPassPassed: results.filter((r) => (r.firstOutcome ?? r.outcome) === 'passed').length,
    recoveredByRetry: results.filter((r) => (r.firstOutcome ?? r.outcome) !== 'passed' && r.outcome === 'passed').length,
    unresolvedAfterRetry: results.filter((r) => r.outcome === 'failed' || r.outcome === 'blocked').length,
  };
  const triage = summarizeFailures(results);
  const triageBlock = triage.length
    ? `<h2>Why cases did not pass</h2><ul class="triage">${triage
        .map(([c, n]) => `<li><b>${xmlEscape(c)}</b> × ${n} — ${xmlEscape(categoryHint(c))}</li>`)
        .join('')}</ul>`
    : '';
  const firstPassRate = summary.total ? ((summary.firstPassPassed / summary.total) * 100).toFixed(1) : '0.0';
  const postRetryRate = summary.total ? ((summary.passed / summary.total) * 100).toFixed(1) : '0.0';
  return `<!doctype html><html><head><meta charset="utf-8"><title>d365fo-agentic report</title>
<style>
body{font-family:system-ui,sans-serif;margin:24px;color:#222}
h1{margin:0 0 8px}
.summary{display:flex;gap:12px;margin:16px 0}
.summary div{padding:8px 12px;border-radius:8px;background:#f2f2f7;font-weight:600}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:8px 10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
th{background:#fafafa}
.badge{padding:2px 8px;border-radius:12px;color:#fff;font-size:12px;text-transform:uppercase}
.badge.passed{background:#22a06b}
.badge.failed{background:#d64545}
.badge.blocked{background:#c07a1f}
.badge.skipped{background:#7a7a80}
.data{margin-top:6px;padding:6px 8px;border-left:3px solid #4a6fa5;background:#f1f5fb;font-size:12px}
.cat{padding:2px 6px;border-radius:6px;background:#eef;font-size:12px;cursor:help}
h2{font-size:16px;margin:16px 0 6px}
.triage{margin:0 0 16px;padding-left:20px;font-size:14px}
.guard{margin-top:6px;padding:6px 8px;border-left:3px solid #c07a1f;background:#fff8ec;font-size:12px}
</style></head><body>
<h1>d365fo-agentic — test run</h1>
<div class="summary">
  <div>Total: ${summary.total}</div>
  <div>Passed: ${summary.passed}</div>
  <div>Failed: ${summary.failed}</div>
  <div>Blocked: ${summary.blocked}</div>
  <div>Skipped: ${summary.skipped}</div>
  <div>First-pass pass rate: ${firstPassRate}%</div>
  <div>Post-retry pass rate: ${postRetryRate}%</div>
  <div>Recovered by retry: ${summary.recoveredByRetry}</div>
  <div>Unresolved after retry: ${summary.unresolvedAfterRetry}</div>
</div>
${triageBlock}
<table>
<thead><tr><th>ID</th><th>Title</th><th>Outcome</th><th>Category</th><th>Attempts</th><th>First→Final</th><th>Duration</th><th>Steps</th><th>Error</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;
}
