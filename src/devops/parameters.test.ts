import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyParameters, applyToSteps, mergeParameterValues, parameterTokens, parseDataSource, parseParameterData, parseParameterNames, renderDataSource, renderParameters, valuesForRow, type ParameterData } from './parameters.js';

const schema = '<xs:schema id="NewDataSet" xmlns=""><xs:element name="NewDataSet"><xs:complexType><xs:choice><xs:element name="Table1"><xs:complexType><xs:sequence><xs:element name="Vendor" type="xs:string" minOccurs="0"/></xs:sequence></xs:complexType></xs:element></xs:choice></xs:complexType></xs:element></xs:schema>';

describe('parameter data', () => {
  it('reads the names and the data rows, including empty and escaped values', () => {
    const fields = {
      'Microsoft.VSTS.TCM.Parameters': '<parameters><param name="Vendor" bind="default"/><param name="Approver" bind="default"/></parameters>',
      'Microsoft.VSTS.TCM.LocalDataSource': `<NewDataSet>${schema}<Table1><Vendor>US-101</Vendor><Approver /><Delivery_x0020_Address>1 High St &amp; Co</Delivery_x0020_Address></Table1><Table1><Vendor>US-102</Vendor><Approver>jo</Approver></Table1></NewDataSet>`,
    };
    assert.deepEqual(parseParameterData(fields), {
      names: ['Vendor', 'Approver', 'Delivery Address'],
      rows: [{ Vendor: 'US-101', Approver: '', 'Delivery Address': '1 High St & Co' }, { Vendor: 'US-102', Approver: 'jo' }],
    });
  });

  it('copes with missing or unrelated fields', () => {
    assert.deepEqual(parseParameterData({}), { names: [], rows: [] });
    assert.deepEqual(parseDataSource('<NewDataSet></NewDataSet>'), []);
    assert.deepEqual(parseParameterNames('<parameters><param bind="x" name="A"/></parameters>'), ['A']);
  });

  it('takes the first non-empty value across the case and its shared sets', () => {
    const local: ParameterData = { names: ['A', 'B'], rows: [{ A: '', B: 'local-b' }] };
    const shared1: ParameterData = { names: ['A'], rows: [{ A: 'shared-a' }] };
    const shared2: ParameterData = { names: ['A', 'C'], rows: [{ A: 'other', C: 'c' }] };
    assert.deepEqual(valuesForRow([local, shared1, shared2]), { B: 'local-b', A: 'shared-a', C: 'c' });
  });
});

describe('writing parameter data', () => {
  it('renders data that reads back the same', () => {
    const data: ParameterData = { names: ['Vendor', 'Approver', 'Delivery Address'], rows: [{ Vendor: 'US-101', Approver: '', 'Delivery Address': '1 High St & <Co>' }, { Vendor: 'US-102' }] };
    const fields = { 'Microsoft.VSTS.TCM.Parameters': renderParameters(data.names), 'Microsoft.VSTS.TCM.LocalDataSource': renderDataSource(data.names, data.rows) };
    assert.deepEqual(parseParameterData(fields), { names: data.names, rows: [{ Vendor: 'US-101', 'Delivery Address': '1 High St & <Co>' }, { Vendor: 'US-102' }] });
    assert.match(fields['Microsoft.VSTS.TCM.Parameters'], /<param name="Vendor" bind="default" \/>/);
  });

  it('fills only empty parameters of the first row and keeps everything else', () => {
    const existing: ParameterData = { names: ['A', 'B'], rows: [{ A: 'keep', B: '' }, { A: 'second', B: 'row' }] };
    const { data, saved, skipped } = mergeParameterValues(existing, { A: 'new', B: 'filled', C: 'added', D: '  ' });
    assert.deepEqual(saved, ['B', 'C']);
    assert.deepEqual(skipped, ['A']);
    assert.deepEqual(data, { names: ['A', 'B', 'C'], rows: [{ A: 'keep', B: 'filled', C: 'added' }, { A: 'second', B: 'row' }] });
    assert.deepEqual(existing.rows[0], { A: 'keep', B: '' }, 'the input is not changed');
  });

  it('starts a table when the case has none', () => {
    const { data, saved } = mergeParameterValues({ names: [], rows: [] }, { Vendor: 'US-101' });
    assert.deepEqual(data, { names: ['Vendor'], rows: [{ Vendor: 'US-101' }] });
    assert.deepEqual(saved, ['Vendor']);
  });
});

describe('applying parameters', () => {
  it('replaces @Name case-insensitively, longest name first, and leaves names without a value', () => {
    const text = 'Select @Vendor and @VendorGroup; ask @approver or @Unknown. Mail a@vendor.com, not @Vendor1';
    assert.equal(
      applyParameters(text, { Vendor: 'US-101', VendorGroup: '10', Approver: 'jo' }),
      'Select US-101 and 10; ask jo or @Unknown. Mail a@vendor.com, not @Vendor1',
    );
  });

  it('inserts values literally, even ones with $ patterns', () => {
    assert.equal(applyParameters('Pay @Amount', { Amount: '$& 5 $1' }), 'Pay $& 5 $1');
  });

  it('lists the distinct tokens of a text', () => {
    assert.deepEqual(parameterTokens('@A then @B then @A, mail x@y.com'), ['A', 'B']);
  });

  it('fills the steps and says what is filled and what is not', () => {
    const steps = [{ index: 1, action: 'Use @Vendor in @LegalEntity', expected: '@Vendor is active' }, { index: 2, action: 'Plain step' }];
    const { steps: out, summary } = applyToSteps(steps, [{ names: ['Vendor'], rows: [{ Vendor: 'US-101' }, { Vendor: 'US-102' }] }]);
    assert.deepEqual(out, [{ index: 1, action: 'Use US-101 in @LegalEntity', expected: 'US-101 is active' }, { index: 2, action: 'Plain step' }]);
    assert.deepEqual(summary, { row: 1, rows: 2, filled: ['Vendor'], unresolved: ['LegalEntity'] });
  });

  it('reports nothing for steps without parameters', () => {
    const steps = [{ index: 1, action: 'Open the page' }];
    assert.deepEqual(applyToSteps(steps, []), { steps, summary: undefined });
  });
});
