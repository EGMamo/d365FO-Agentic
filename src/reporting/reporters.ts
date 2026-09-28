import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestResult } from '../testing/types.js';

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

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toJUnit(results: TestResult[]): string {
  const total = results.length;
  const failures = results.filter((r) => r.outcome === 'failed').length;
  const skipped = results.filter((r) => r.outcome === 'skipped' || r.outcome === 'blocked').length;
  const timeSec = (results.reduce((s, r) => s + r.durationMs, 0) / 1000).toFixed(3);
  const cases = results
    .map((r) => {
      const t = (r.durationMs / 1000).toFixed(3);
      let body = '';
      if (r.outcome === 'failed') {
        body = `<failure message="${xmlEscape(r.errorMessage ?? 'failed')}">${xmlEscape(r.errorMessage ?? '')}</failure>`;
      } else if (r.outcome === 'skipped' || r.outcome === 'blocked') {
        body = `<skipped/>`;
      }
      return `<testcase classname="d365fo-agentic" name="${xmlEscape(r.title)}" time="${t}">${body}</testcase>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="d365fo-agentic" tests="${total}" failures="${failures}" skipped="${skipped}" time="${timeSec}">
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
  <td><span class="badge ${r.outcome}">${r.outcome}</span></td>
  <td>${(r.durationMs / 1000).toFixed(2)}s</td>
  <td>${r.steps.length}</td>
  <td>${r.errorMessage ? xmlEscape(r.errorMessage) : ''}</td>
</tr>`,
    )
    .join('');
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.outcome === 'passed').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
    blocked: results.filter((r) => r.outcome === 'blocked').length,
    skipped: results.filter((r) => r.outcome === 'skipped').length,
  };
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
</style></head><body>
<h1>d365fo-agentic — test run</h1>
<div class="summary">
  <div>Total: ${summary.total}</div>
  <div>Passed: ${summary.passed}</div>
  <div>Failed: ${summary.failed}</div>
  <div>Blocked: ${summary.blocked}</div>
  <div>Skipped: ${summary.skipped}</div>
</div>
<table>
<thead><tr><th>ID</th><th>Title</th><th>Outcome</th><th>Duration</th><th>Steps</th><th>Error</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;
}
