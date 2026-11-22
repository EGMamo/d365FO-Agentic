import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifySystem, describeMissing, findPlaceholders, isDescriptive, placeholderKey, preflightCase, preflightSteps, standsForARole } from './preflight.js';
import type { LlmCompleteRequest, LlmCompleteResponse } from '../llm/types.js';
import type { TestCase } from '../testing/types.js';

const tc = (steps: TestCase['steps'], preconditions?: string): TestCase => ({ id: '10', source: 'local', title: 'Create supplier', steps, ...(preconditions ? { preconditions } : {}) });

function fakeLlm(reply: (req: LlmCompleteRequest) => LlmCompleteResponse) {
  const calls: LlmCompleteRequest[] = [];
  return { calls, llm: { name: 'fake', async complete(req: LlmCompleteRequest) { calls.push(req); return reply(req); } } };
}
const classified = (list: Array<{ id: number | string; kind: string }>): LlmCompleteResponse => ({
  text: '', stopReason: 'tool_use', toolCalls: [{ id: 'c', name: 'classify_placeholders', arguments: { placeholders: list } }], usage: { inputTokens: 100, outputTokens: 20 },
});

describe('findPlaceholders', () => {
  it('keeps the description that follows a marker, up to the closing bracket', () => {
    const found = findPlaceholders(tc([{ index: 7, action: 'Select the Group (TBC - confirm UK supplier group for UAT).' }]));
    assert.deepEqual(found, [{ step: 7, where: 'action', text: 'TBC - confirm UK supplier group for UAT' }]);
  });

  it('finds markers in actions, expected results and preconditions, in order, without case sensitivity', () => {
    const found = findPlaceholders(tc(
      [{ index: 1, action: 'Open the workflow (tbd: menu path)', expected: 'Status is TBC - awaiting approval' }, { index: 2, action: 'Enter {{ vendor group }} and <supplier type>' }],
      'Supplier from TC1: to be confirmed',
    ));
    assert.deepEqual(found.map((p) => [p.step, p.where, p.text]), [
      [0, 'preconditions', 'to be confirmed'],
      [1, 'action', 'tbd - menu path'],
      [1, 'expected', 'TBC - awaiting approval'],
      [2, 'action', '{{ vendor group }}'],
      [2, 'action', '<supplier type>'],
    ]);
  });

  it('ignores comparisons, short tags and words that merely contain the letters', () => {
    const found = findPlaceholders(tc([{ index: 1, action: 'Check that amount < 100 and > 5, open <b>, TBCX and ATBD are codes' }]));
    assert.deepEqual(found, []);
  });

  it('treats only described placeholders as the same across steps', () => {
    assert.equal(isDescriptive('TBC'), false);
    assert.equal(isDescriptive('to be confirmed'), false);
    assert.equal(isDescriptive('TBC - supplier group'), true);
    assert.equal(placeholderKey('TBC – Supplier  Group'), placeholderKey('tbc - supplier group'));
  });
});

describe('preflightCase', () => {
  it('makes no model call for a case without placeholders', async () => {
    const { llm, calls } = fakeLlm(() => classified([]));
    const report = await preflightCase(tc([{ index: 1, action: 'Open All suppliers' }]), llm);
    assert.equal(calls.length, 0);
    assert.deepEqual(report.missing, []);
    assert.equal(report.usage.turns, 0);
  });

  it('asks the model once and returns the placeholders it calls missing, with its usage', async () => {
    const { llm, calls } = fakeLlm(() => classified([{ id: 0, kind: 'generate' }, { id: '1', kind: 'missing' }]));
    const report = await preflightCase(tc([{ index: 5, action: 'Enter account (TBC - unique supplier account)' }, { index: 7, action: 'Group (TBC - supplier group)' }]), llm);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].tools?.map((t) => t.name), ['classify_placeholders']);
    assert.match(calls[0].messages[0].content, /0\. "TBC - unique supplier account"[\s\S]*1\. "TBC - supplier group"/);
    assert.deepEqual(report.missing.map((p) => p.step), [7]);
    assert.equal(report.usage.turns, 1);
    assert.equal(report.usage.inputTokens, 100);
  });

  it('does not block on a placeholder the model left out or gave an unknown kind', async () => {
    const { llm } = fakeLlm(() => classified([{ id: 0, kind: 'unsure' }]));
    const report = await preflightCase(tc([{ index: 1, action: 'Group (TBC - group)' }, { index: 2, action: 'Type (TBC - type)' }]), llm);
    assert.deepEqual(report.missing, []);
    assert.equal(report.error, undefined);
  });

  it('reports an error instead of guessing when the model does not call the tool', async () => {
    const { llm } = fakeLlm(() => ({ text: 'I think step 1 is missing', stopReason: 'end_turn', toolCalls: [] }));
    const report = await preflightCase(tc([{ index: 1, action: 'Group (TBC - group)' }]), llm);
    assert.deepEqual(report.missing, []);
    assert.match(report.error ?? '', /did not classify/);
  });
});

describe('placeholder phrases, after review', () => {
  it('matches a spelled-out phrase only where it stands in for a value', () => {
    const found = findPlaceholders(tc([
      { index: 1, action: 'Check the purchase order', expected: 'Status is ready to be confirmed' },
      { index: 2, action: 'Price to be determined by the trade agreement' },
      { index: 3, action: 'Approver: to be confirmed' },
      { index: 4, action: 'Use the group (to be decided) and save' },
      { index: 5, action: 'to be advised' },
    ]));
    assert.deepEqual(found.map((p) => p.step), [3, 4, 5]);
  });

  it('never blocks on wording the model calls not a placeholder', async () => {
    const { llm } = fakeLlm(() => classified([{ id: 0, kind: 'not_placeholder' }]));
    const report = await preflightCase(tc([{ index: 1, action: 'Group: to be confirmed' }]), llm);
    assert.deepEqual(report.missing, []);
    assert.equal(report.placeholders[0].kind, 'not_placeholder');
  });
});

describe('azure devops parameters', () => {
  it('finds @Name parameters that still have no value, but not e-mail addresses', () => {
    const found = findPlaceholders(tc([{ index: 1, action: 'Pre-requisites: @Approver is assigned; mail jo@contoso.com', expected: '@VendorAccount is active' }]));
    assert.deepEqual(found.map((p) => [p.step, p.where, p.text]), [[1, 'action', '@Approver'], [1, 'expected', '@VendorAccount']]);
    assert.equal(isDescriptive('@Approver'), true, 'the same parameter in two steps is the same placeholder');
  });

  it('tells the classifier what an @Name placeholder is', async () => {
    const { llm, calls } = fakeLlm(() => classified([{ id: 0, kind: 'missing' }]));
    const report = await preflightCase(tc([{ index: 1, action: 'Approver @Approver signs' }]), llm);
    assert.match(calls[0].system ?? '', /@Name is an Azure DevOps test parameter that has no value/);
    assert.deepEqual(report.missing.map((p) => p.text), ['@Approver']);
  });
});

describe('long placeholder lists', () => {
  const many = tc([
    { index: 1, action: 'Use @ItemNumber and @VendorAccount; group TBC' },
    { index: 2, action: 'Check @ItemNumber and @vendoraccount again; type TBC' },
    { index: 3, action: 'Post @ItemNumber' },
  ]);

  it('classifies a described placeholder once and applies the answer to every step that uses it', async () => {
    const { llm, calls } = fakeLlm(() => classified([{ id: 0, kind: 'lookup' }, { id: 1, kind: 'missing' }, { id: 2, kind: 'generate' }, { id: 3, kind: 'missing' }]));
    const report = await preflightCase(many, llm, undefined, { fillFromErp: true });
    const listed = (calls[0].messages[0].content.match(/^\d+\. /gm) ?? []).length;
    assert.equal(listed, 4, '@ItemNumber (3 steps), @VendorAccount (2 steps, any case) and the two bare TBCs: four entries, not eight');
    assert.match(calls[0].messages[0].content, /0\. "@ItemNumber"[^\n]*\[also used in step 1, step 2, step 3\]/);
    assert.deepEqual(report.placeholders.map((p) => [p.step, p.text, p.kind]), [
      [1, '@ItemNumber', 'lookup'], [1, '@VendorAccount', 'missing'], [1, 'TBC', 'generate'],
      [2, '@ItemNumber', 'lookup'], [2, '@vendoraccount', 'missing'], [2, 'TBC', 'missing'],
      [3, '@ItemNumber', 'lookup'],
    ]);
  });

  it('leaves the model room for a long answer, and says so when it was cut off anyway', async () => {
    const { llm, calls } = fakeLlm(() => ({ text: 'thinking…', stopReason: 'max_tokens', toolCalls: [] }));
    const report = await preflightCase(many, llm);
    assert.ok((calls[0].maxTokens ?? 0) >= 2048 + 4 * 100);
    assert.match(report.error ?? '', /cut off at the token limit/);
  });
});

describe('filling unset data from F&O and user roles', () => {
  const vendor = tc([{ index: 1, action: 'Select vendor @VendorAccount in group (TBC - confirm the group)' }]);

  it('does not block on a lookup when the agent can fill it, and lists it to be found', async () => {
    const { llm, calls } = fakeLlm(() => classified([{ id: 0, kind: 'lookup' }, { id: 1, kind: 'missing' }]));
    const report = await preflightCase(vendor, llm, undefined, { fillFromErp: true });
    assert.deepEqual(report.lookup.map((p) => p.text), ['@VendorAccount']);
    assert.deepEqual(report.missing.map((p) => p.text), ['TBC - confirm the group']);
    assert.match(calls[0].system ?? '', /- lookup: it stands for an existing master or setup record/);
  });

  it('treats a lookup as missing data when filling from F&O is off, and does not offer it', async () => {
    const { llm, calls } = fakeLlm(() => classified([{ id: 0, kind: 'lookup' }, { id: 1, kind: 'lookup' }]));
    const report = await preflightCase(vendor, llm, undefined, { fillFromErp: false });
    assert.deepEqual(report.lookup, []);
    assert.equal(report.missing.length, 2);
    assert.doesNotMatch(calls[0].system ?? '', /- lookup:/);
  });

  it('covers a user role with the signed-in user, even when the model calls it missing', async () => {
    const role = tc([{ index: 1, action: 'Pre-requisites: 1. User Role = [TBC] 2. Workflow is active' }, { index: 2, action: 'Group (TBC - supplier group)' }]);
    const { llm } = fakeLlm(() => classified([{ id: 0, kind: 'missing' }, { id: 1, kind: 'missing' }]));
    const ignoring = await preflightCase(role, llm, undefined, { ignoreUserRole: true });
    assert.deepEqual(ignoring.placeholders.map((p) => [p.step, p.kind]), [[1, 'config'], [2, 'missing']]);
    assert.deepEqual(ignoring.missing.map((p) => p.step), [2]);
    const strict = await preflightCase(role, llm, undefined, { ignoreUserRole: false });
    assert.deepEqual(strict.missing.map((p) => p.step), [1, 2], 'with the setting off a role is missing data as before');
  });

  it('recognises a placeholder that directly follows the word role, and no other', () => {
    const t = tc([
      { index: 1, action: 'User Role = [TBC]' },
      { index: 2, action: 'Security role: TBC - Category Head' },
      { index: 3, action: 'Enter the role description then group TBC' },
    ]);
    const [a, b, c] = findPlaceholders(t);
    assert.deepEqual([standsForARole(t, a), standsForARole(t, b), standsForARole(t, c)], [true, true, false]);
  });

  it('words the classifier instructions for the settings in use', () => {
    assert.match(classifySystem({ ignoreUserRole: true }), /user role[\s\S]*never missing data/);
    assert.match(classifySystem({}), /also a user role or another user to act as/);
    assert.match(classifySystem({ fillFromErp: true }), /Between lookup and missing, when unsure, choose missing/);
  });
});

describe('test environment: the agent decides unset values (judge)', () => {
  const vendor = tc([{ index: 1, action: 'Select vendor @VendorAccount in group (TBC - confirm the group)', expected: 'Message TBC - confirmation text' }]);

  it('keeps lookups for the agent even without F&O data access, and never blocks an unset expected result', async () => {
    // The model calls the group and the expected message "missing"; with judge on, the expected one is the agent's to judge.
    const { llm, calls } = fakeLlm(() => classified([{ id: 0, kind: 'lookup' }, { id: 1, kind: 'lookup' }, { id: 2, kind: 'missing' }]));
    const report = await preflightCase(vendor, llm, undefined, { fillFromErp: false, judge: true });
    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.lookup.map((p) => p.text), ['@VendorAccount', 'TBC - confirm the group']);
    assert.match(calls[0].system ?? '', /TEST environment/);
    assert.match(calls[0].system ?? '', /When unsure, choose lookup or generate, never missing/);
  });

  it('still blocks what only an earlier case or a secret can supply, when the model says so', async () => {
    const { llm } = fakeLlm(() => classified([{ id: 0, kind: 'missing' }, { id: 1, kind: 'generate' }, { id: 2, kind: 'not_placeholder' }]));
    const report = await preflightCase(vendor, llm, undefined, { judge: true });
    assert.deepEqual(report.missing.map((p) => p.text), ['@VendorAccount']);
  });
});

describe('preflightSteps', () => {
  it('blocks the steps with a missing placeholder, names it, and skips the rest', () => {
    const steps = preflightSteps(tc([{ index: 1, action: 'Open' }, { index: 2, action: 'x', expected: 'TBC - message' }]), [{ step: 2, where: 'expected', text: 'TBC - message' }]);
    assert.deepEqual(steps.map((s) => [s.index, s.status, s.cause]), [[1, 'skipped', undefined], [2, 'blocked', 'missing_data']]);
    assert.match(steps[1].errorMessage ?? '', /"TBC - message" \(expected result\)/);
  });

  it('blocks the first step when the preconditions are missing', () => {
    const steps = preflightSteps(tc([{ index: 1, action: 'Open' }, { index: 2, action: 'Save' }]), [{ step: 0, where: 'preconditions', text: 'TBC - supplier from TC1' }]);
    assert.equal(steps[0].status, 'blocked');
    assert.match(steps[0].errorMessage ?? '', /\(preconditions\)/);
    assert.equal(steps[1].status, 'skipped');
  });

  it('summarises long lists', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ step: i + 1, where: 'action' as const, text: `TBC - v${i}` }));
    assert.match(describeMissing(many, 3), /^step 1 "TBC - v0", step 2 "TBC - v1", step 3 "TBC - v2", and 7 more$/);
  });
});
