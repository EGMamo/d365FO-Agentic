import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from './index.js';

describe('report folder of a profile', () => {
  it('follows the profile id unless REPORT_DIR is set', () => {
    assert.equal(parseConfig({}).REPORT_DIR, './reports');
    assert.equal(parseConfig({ PROFILE_ID: 'a1b2c3d4e5' }).REPORT_DIR, './reports/a1b2c3d4e5');
    assert.equal(parseConfig({ PROFILE_ID: 'a1b2c3d4e5', REPORT_DIR: 'out' }).REPORT_DIR, 'out');
  });
});
