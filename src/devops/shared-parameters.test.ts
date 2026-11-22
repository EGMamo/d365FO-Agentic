import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapSharedParameterData, parseParameterData, sharedParameterMapping, valuesForRow, DATASOURCE_FIELD, PARAMETERS_FIELD } from './parameters.js';

describe('shared parameter iterations', () => {
  it('retains every shared-set row and maps shared names to local names', () => {
    const shared = parseParameterData({
      [PARAMETERS_FIELD]: '<parameterSet><paramData><dataRow><kvp key="Vendor" value="US-101"/><kvp key="Company" value="USMF"/></dataRow><dataRow><kvp key="Vendor" value="US-202"/><kvp key="Company" value="DEMF"/></dataRow></paramData></parameterSet>',
    });
    assert.deepEqual(shared.rows, [{ Vendor: 'US-101', Company: 'USMF' }, { Vendor: 'US-202', Company: 'DEMF' }]);
    const fields = {
      [DATASOURCE_FIELD]: JSON.stringify({
        sharedParameterDataSetIds: [77],
        parameterMap: [{ localParamName: 'Supplier', sharedParameterName: 'Vendor', sharedParameterDataSetId: 77 }],
      }),
    };
    const mapping = sharedParameterMapping(fields);
    assert.deepEqual(mapping.ids, [77]);
    const mapped = mapSharedParameterData(shared, mapping, 77);
    assert.deepEqual(valuesForRow([mapped], 1), { Supplier: 'US-202' });
  });
});
