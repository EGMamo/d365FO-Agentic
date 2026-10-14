import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeReports } from './reporters.js';
import type { TestResult } from '../testing/types.js';

const base: TestResult = { testCaseId: '1', title: 't', outcome: 'failed', runState: 'failed', startedAt: '', finishedAt: '', durationMs: 0, steps: [], artifacts: [], errorMessage: 'Total was 10' };

test('reports show the failure category and its hint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rep-'));
  const paths = await writeReports(dir, [{ ...base, failureCategory: 'assertion' }]);
  assert.match(await readFile(paths.junit, 'utf8'), /<failure [^>]*type="assertion"/);
  assert.match(await readFile(paths.html, 'utf8'), /<span class="cat" title="Possible product defect[^"]*">assertion<\/span>/);
});

test('a category this version does not know is escaped instead of breaking the report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rep-'));
  const foreign = { ...base, failureCategory: '"><script>x</script>' } as unknown as TestResult;
  const paths = await writeReports(dir, [foreign]);
  const html = await readFile(paths.html, 'utf8');
  const junit = await readFile(paths.junit, 'utf8');
  assert.doesNotMatch(html, /<script>x/);
  assert.doesNotMatch(junit, /<script>x/);
  assert.match(junit, /type="&quot;&gt;&lt;script&gt;/);
});

test('JUnit reports a blocked case as an error and an interrupted one as skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rep-'));
  const blocked: TestResult = { ...base, testCaseId: '2', title: 'blocked case', outcome: 'blocked', runState: 'blocked', failureCategory: 'sign_in', errorMessage: 'Sign-in asked for MFA' };
  const stopped: TestResult = { ...base, testCaseId: '3', title: 'stopped case', outcome: 'blocked', runState: 'blocked', failureCategory: 'infrastructure', interrupted: true, errorMessage: 'Run interrupted' };
  const junit = await readFile((await writeReports(dir, [{ ...base, failureCategory: 'assertion' }, blocked, stopped, { ...base, outcome: 'passed', runState: 'completed' }])).junit, 'utf8');
  assert.match(junit, /tests="4" failures="1" errors="1" skipped="1"/);
  assert.match(junit, /name="blocked case"[^>]*><error message="blocked: Sign-in asked for MFA" type="sign_in">/);
  assert.match(junit, /name="stopped case"[^>]*><skipped /);
});

test('reports say when a case was replayed without the AI, and where a failed replay stopped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rep-'));
  const replayed: TestResult = { ...base, testCaseId: '4', outcome: 'passed', runState: 'completed', errorMessage: undefined, replay: { outcome: 'passed' } };
  const fellBack: TestResult = { ...base, testCaseId: '5', replay: { outcome: 'failed', step: 2, error: 'locator.click: <Timeout>' } };
  const paths = await writeReports(dir, [replayed, fellBack]);
  const html = await readFile(paths.html, 'utf8');
  assert.match(html, /Replayed from the last passing run, without the AI\./);
  assert.match(html, /failed at step 2, so the AI ran it: locator\.click: &lt;Timeout&gt;/);
  assert.match(await readFile(paths.junit, 'utf8'), /replay=failed at step 2/);
});
