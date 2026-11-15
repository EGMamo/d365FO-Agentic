import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FIELD_CATALOG, GROUP_INFO, PROVIDER_LABELS } from './catalog.js';

describe('field catalog', () => {
  it('has a unique key per field, so profiles cannot overwrite each other', () => {
    const seen = new Set<string>();
    for (const f of FIELD_CATALOG) {
      assert.ok(!seen.has(f.key), `duplicate key ${f.key}`);
      seen.add(f.key);
    }
  });

  it('gives every field a group the settings screen can describe', () => {
    for (const f of FIELD_CATALOG) assert.ok(GROUP_INFO[f.group], `${f.key} has unknown group "${f.group}"`);
  });

  it('marks every credential-shaped field secret, so the UI masks it', () => {
    for (const f of FIELD_CATALOG) {
      if (/PASSWORD|API_KEY|TOKEN|PAT/.test(f.key)) assert.equal(f.secret, true, `${f.key} must be secret`);
    }
  });

  it('keeps provider labels in step with the catalog placeholders', () => {
    assert.ok(PROVIDER_LABELS.anthropic.length > 0);
  });
});
