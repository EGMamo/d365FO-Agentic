import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeBase, knownPathSummary, STALE_PATH_FAILURES, tokenize } from './kb.js';

async function freshKb(): Promise<{ kb: KnowledgeBase; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'kb-'));
  const kb = new KnowledgeBase(dir);
  await kb.load();
  return { kb, dir };
}

test('tokenize stems, expands F&O abbreviations and maps synonyms', () => {
  assert.deepEqual(tokenize('PO'), tokenize('purchase orders'));
  assert.deepEqual(tokenize('Supplier'), tokenize('vendors'));
  assert.deepEqual(tokenize('posting'), tokenize('posted'));
  assert.deepEqual(tokenize('verified'), tokenize('validate'));
  assert.deepEqual(tokenize('the test case for'), []);
});

test('retrieve ranks relevant entries with synonyms and module boost', async () => {
  const { kb } = await freshKb();
  kb.upsert({ kind: 'remediation', summary: 'Vendor lookup needs filter', details: 'Type the vendor account then press Tab', tags: ['ap'], module: 'AP' });
  kb.upsert({ kind: 'remediation', summary: 'Sales order totals pane', details: 'Open the Totals action pane', tags: [], module: 'AR' });
  kb.upsert({ kind: 'selector', summary: 'Ledger journal grid', details: 'Use the Lines tab', tags: [], module: 'GL' });
  const hits = kb.retrieve('Create a supplier invoice', [], 5, 'AP');
  assert.equal(hits[0]?.summary, 'Vendor lookup needs filter');
  assert.ok(!hits.some((h) => h.summary === 'Ledger journal grid'));
  assert.deepEqual(kb.retrieve('', [], 5), []);
});

test('retrieve prefers entries with a better track record when relevance ties', async () => {
  const { kb } = await freshKb();
  kb.upsert({ kind: 'remediation', summary: 'Customer grid filter A', details: 'x', tags: [], failureCount: 4 });
  kb.upsert({ kind: 'remediation', summary: 'Customer grid filter B', details: 'x', tags: [], successCount: 4 });
  assert.equal(kb.retrieve('customer filter')[0]?.summary, 'Customer grid filter B');
});

test('known-good path goes stale after consecutive failures and resets when it changes', async () => {
  const { kb } = await freshKb();
  const summary = knownPathSummary('TC-1');
  kb.upsert({ kind: 'recipe', summary, details: 'click A', tags: [], testCaseId: 'TC-1', successCount: 1 });
  for (let i = 0; i < STALE_PATH_FAILURES; i++) kb.upsert({ kind: 'recipe', summary, details: '', tags: [], testCaseId: 'TC-1', failureCount: 1 });
  assert.equal(kb.recipeFor('TC-1'), undefined);
  assert.equal(kb.stats().staleKnownPaths, 1);
  kb.upsert({ kind: 'recipe', summary, details: 'click B', tags: [], testCaseId: 'TC-1', successCount: 1 });
  const path = kb.recipeFor('TC-1');
  assert.equal(path?.details, 'click B');
  assert.equal(path?.successCount, 1);
  assert.equal(path?.failureCount, 0);
  assert.deepEqual(kb.retrieve('known good path TC-1 click'), []);
});

test('save is atomic and round-trips', async () => {
  const { kb, dir } = await freshKb();
  kb.upsert({ kind: 'doc', summary: 'Doc', details: 'd', tags: ['t'] });
  await Promise.all([kb.save(), kb.save()]);
  assert.deepEqual(await readdir(dir), ['kb.json']);
  const again = new KnowledgeBase(dir);
  await again.load();
  assert.equal(again.all().length, 1);
});

test('a corrupt kb.json is moved aside instead of being overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kb-'));
  await writeFile(join(dir, 'kb.json'), '{ not json', 'utf8');
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    const kb = new KnowledgeBase(dir);
    await kb.load();
    assert.equal(kb.all().length, 0);
  } finally {
    console.warn = warn;
  }
  const files = await readdir(dir);
  const backup = files.find((f) => f.startsWith('kb.json.corrupt-'));
  assert.ok(backup);
  assert.equal(await readFile(join(dir, backup!), 'utf8'), '{ not json');
});

test('load drops malformed entries and fills defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kb-'));
  await writeFile(join(dir, 'kb.json'), JSON.stringify({ version: 1, entries: [{ kind: 'doc', summary: 'ok' }, { kind: 'bogus', summary: 'x' }, null] }), 'utf8');
  const kb = new KnowledgeBase(dir);
  await kb.load();
  const [e] = kb.all();
  assert.equal(kb.all().length, 1);
  assert.deepEqual([e.tags, e.successCount, e.failureCount, e.details], [[], 0, 0, '']);
});

test('prune removes unreliable, stale and old unconfirmed entries', async () => {
  const { kb } = await freshKb();
  kb.upsert({ kind: 'remediation', summary: 'bad', details: '', tags: [], failureCount: 3 });
  kb.upsert({ kind: 'remediation', summary: 'good', details: '', tags: [], failureCount: 3, successCount: 5 });
  kb.upsert({ kind: 'doc', summary: 'unconfirmed', details: '', tags: [] });
  assert.deepEqual(kb.prune().map((e) => e.summary), ['bad']);
  const future = new Date(Date.now() + 100 * 86_400_000);
  assert.deepEqual(kb.prune({ maxAgeDays: 30, now: future }).map((e) => e.summary), ['unconfirmed']);
  assert.deepEqual(kb.all().map((e) => e.summary), ['good']);
});

test('recordOutcome credits or debits the entries a run used, and a failing known path goes stale', async () => {
  const { kb } = await freshKb();
  const tip = kb.upsert({ kind: 'remediation', summary: 'Pick vendor group first', details: 'd', tags: [] });
  const path = kb.upsert({ kind: 'recipe', summary: knownPathSummary('TC-1'), details: 'click "New"', tags: [], testCaseId: 'TC-1' });
  assert.equal(kb.recordOutcome([tip.id, tip.id, 'missing'], true), 1);
  assert.equal(kb.all().find((e) => e.id === tip.id)?.successCount, 1);
  assert.ok(kb.recipeFor('TC-1'));
  for (let i = 0; i < STALE_PATH_FAILURES; i++) kb.recordOutcome([path.id], false);
  assert.equal(kb.recipeFor('TC-1'), undefined);
  kb.recordOutcome([path.id], true);
  assert.ok(kb.recipeFor('TC-1'));
});

test('load backs up a file with unusable entries and tolerates wrongly typed fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kb-'));
  await writeFile(
    join(dir, 'kb.json'),
    JSON.stringify({
      version: 1,
      entries: [
        { kind: 'recipe', summary: 'Create vendor', details: 'Open All vendors', module: 42, testCaseId: 7, consecutiveFailures: 'x', updatedAt: 5, tags: 'ap' },
        { kind: 'nonsense', summary: 'bad kind' },
        { kind: 'recipe' },
      ],
    }),
  );
  const kb = new KnowledgeBase(dir);
  await kb.load();
  const [e] = kb.all();
  assert.equal(kb.all().length, 1);
  assert.equal(e!.module, undefined);
  assert.equal(e!.testCaseId, undefined);
  assert.equal(e!.consecutiveFailures, 0);
  assert.deepEqual(e!.tags, []);
  assert.equal(kb.retrieve('create vendor', [], 5, 'Accounts payable')[0]?.summary, 'Create vendor');
  assert.ok((await readdir(dir)).some((f) => f.startsWith('kb.json.invalid-')));
});

test('a shared module or tag alone does not make an entry relevant', async () => {
  const { kb } = await freshKb();
  kb.upsert({ kind: 'selector', summary: 'Fixed asset book grid', details: 'Use the Books tab', tags: ['smoke'], module: 'Accounts payable' });
  assert.deepEqual(kb.retrieve('add a new supplier', ['smoke'], 5, 'Accounts payable'), []);
  assert.equal(kb.retrieve('fixed asset books', ['smoke'], 5, 'Accounts payable').length, 1);
});

test('tokenize does not read ordinary words as abbreviations', () => {
  assert.deepEqual(tokenize('so'), []);
  assert.deepEqual(tokenize('SO'), tokenize('sales order'));
  assert.ok(!tokenize('POS terminal').includes('purchase'));
  assert.ok(!tokenize('inv').includes('invoice'));
});

test('a failed save leaves no temp file behind', async () => {
  const { kb, dir } = await freshKb();
  kb.upsert({ kind: 'doc', summary: 'x', details: 'y', tags: [] });
  await mkdir(join(dir, 'kb.json'));
  await assert.rejects(kb.save());
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
});

test('two processes saving the same file keep each other\'s entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kb-'));
  const seed = new KnowledgeBase(dir);
  await seed.load();
  const shared = seed.upsert({ kind: 'doc', summary: 'Shared entry', details: 'v1', tags: [] });
  const doomed = seed.upsert({ kind: 'doc', summary: 'Unreliable entry', details: 'x', tags: [], failureCount: 5 });
  await seed.save();

  const a = new KnowledgeBase(dir);
  const b = new KnowledgeBase(dir);
  await a.load();
  await b.load();
  a.upsert({ kind: 'recipe', summary: 'Added by A', details: 'a', tags: [] });
  b.upsert({ kind: 'recipe', summary: 'Added by B', details: 'b', tags: [] });
  b.recordOutcome([shared.id], true);
  assert.deepEqual(a.prune().map((e) => e.id), [doomed.id]);
  await b.save();
  await a.save();

  const after = new KnowledgeBase(dir);
  await after.load();
  assert.deepEqual(after.all().map((e) => e.summary).sort(), ['Added by A', 'Added by B', 'Shared entry']);
  assert.equal(after.all().find((e) => e.id === shared.id)?.successCount, 1);

  // B still holds the pruned entry in memory; its next save must not bring it back.
  await b.save();
  const final = new KnowledgeBase(dir);
  await final.load();
  assert.ok(!final.all().some((e) => e.id === doomed.id));
});

test('stem undoubles the consonant left by -ing and -ed but keeps real doubles', () => {
  assert.deepEqual(tokenize('running'), tokenize('run'));
  assert.deepEqual(tokenize('stopped'), tokenize('stop'));
  assert.deepEqual(tokenize('filled passing added'), tokenize('fill pass add'));
});

// A small relevance set: each query must bring back the entry a tester would expect first. It guards the
// tokenizer, synonyms and scoring against changes that look harmless but reorder results.
test('retrieval evaluation set: the expected entry ranks first', async () => {
  const { kb } = await freshKb();
  const entries: Array<[string, string, string, string[]]> = [
    ['Vendor account lookup needs a filter', 'In All vendors type the account in the quick filter then press Enter', 'Accounts payable', ['vendor']],
    ['Post a vendor invoice journal', 'Open Invoice journal, add a line, then select Post on the action pane', 'Accounts payable', ['invoice']],
    ['Confirm a purchase order', 'On the Purchase tab select Confirm; the status changes to Confirmed', 'Procurement and sourcing', ['po']],
    ['Sales order totals are on the action pane', 'Open the Sell tab and select Totals to see the order total', 'Accounts receivable', ['sales']],
    ['Switch legal entity from the company picker', 'Select the company code in the navigation bar and choose another one', 'System administration', []],
    ['General journal lines grid needs a refresh', 'After posting the ledger journal press Shift+F5 to refresh the lines', 'General ledger', ['journal']],
    ['Fixed asset book is created on the Books tab', 'Open the fixed asset, select Books, then add a value model', 'Fixed assets', []],
    ['Customer credit limit message bar', 'Saving a sales order over the credit limit shows a warning message bar', 'Accounts receivable', ['customer']],
    ['Sign-in page asks to stay signed in', 'Choose No on the Stay signed in prompt to reach the dashboard', 'System administration', ['login']],
    ['Inventory on-hand list filter by warehouse', 'Use the Warehouse column filter on the On-hand list page', 'Inventory management', []],
  ];
  for (const [summary, details, module, tags] of entries) kb.upsert({ kind: 'recipe', summary, details, module, tags });
  const queries: Array<[string, string | undefined, string]> = [
    ['find a supplier by account number', 'Accounts payable', 'Vendor account lookup needs a filter'],
    ['posting supplier invoices', 'Accounts payable', 'Post a vendor invoice journal'],
    ['confirm the PO', 'Procurement and sourcing', 'Confirm a purchase order'],
    ['check the SO total amount', undefined, 'Sales order totals are on the action pane'],
    ['change LE to DEMF', undefined, 'Switch legal entity from the company picker'],
    ['GL journal lines not refreshed after posting', 'General ledger', 'General journal lines grid needs a refresh'],
    ['add a book to a FA', undefined, 'Fixed asset book is created on the Books tab'],
    ['client over credit limit warning', 'Accounts receivable', 'Customer credit limit message bar'],
    ['logon keeps asking to stay signed in', undefined, 'Sign-in page asks to stay signed in'],
    ['on-hand stock per warehouse', undefined, 'Inventory on-hand list filter by warehouse'],
  ];
  const misses = queries.filter(([q, module, want]) => kb.retrieve(q, [], 3, module)[0]?.summary !== want).map(([q, module]) => `${q} -> ${kb.retrieve(q, [], 3, module)[0]?.summary}`);
  assert.deepEqual(misses, []);
  assert.deepEqual(kb.retrieve('payroll tax report for employees', [], 3), []);
});
