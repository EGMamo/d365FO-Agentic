import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { mergeMenuItems, PageMap, pageKey } from './page-map.js';

const VENDORS = { url: 'https://fo/?cmp=USMF&mi=VendTableListPage', title: 'All vendors -- Finance and Operations' };

describe('PageMap', () => {
  it('keys pages by menu item, else by caption', () => {
    assert.equal(pageKey(VENDORS), 'mi:vendtablelistpage');
    assert.equal(pageKey({ url: 'https://fo/?cmp=USMF', title: 'Dashboard -- Finance and Operations' }), 'title:dashboard');
    assert.equal(pageKey(undefined), undefined);
  });

  it('learns controls, hints them back and survives a reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pages-'));
    const map = await PageMap.load(dir);
    const key = map.visit(VENDORS)!;
    map.learnControl(key, 'New button', "getByTestId('SystemDefinedNewButton')", 'click');
    map.learnControl(key, 'New button', "getByTestId('SystemDefinedNewButton')", 'click');
    map.addNote(key, 'Vendor group is on the General FastTab');
    await map.save();

    const again = await PageMap.load(dir);
    const hint = again.hint(key) ?? '';
    assert.match(hint, /Learned about All vendors \(VendTableListPage\)/);
    assert.match(hint, /"New button" \(click\): target getByTestId\('SystemDefinedNewButton'\)\s+\[worked 2x\]/);
    assert.match(hint, /Note: Vendor group is on the General FastTab/);
    assert.deepEqual(again.menuItems(), [{ mi: 'VendTableListPage', label: 'All vendors' }]);
  });

  it('drops a control once it fails more often than it worked', async () => {
    const map = await PageMap.load(await mkdtemp(join(tmpdir(), 'pages-')));
    const key = map.visit(VENDORS)!;
    map.learnControl(key, 'Edit', "getByTestId('SystemDefinedEditButton')", 'click');
    map.failControl(key, "getByTestId('SystemDefinedEditButton')");
    assert.equal(map.get(key)?.controls.length, 1);
    map.failControl(key, "getByTestId('SystemDefinedEditButton')");
    assert.equal(map.get(key)?.controls.length, 0);
    assert.equal(map.hint(key), undefined);
  });

  it('merges learned forms into the menu items without overriding built-ins', () => {
    const merged = mergeMenuItems(
      [{ mi: 'VendTableListPage', label: 'All vendors', path: 'Accounts payable > Vendors' }],
      [{ mi: 'VendTableListPage', label: 'Alle Kreditoren' }, { mi: 'WHSWaveTemplateTable', label: 'Wave templates' }],
    );
    assert.deepEqual(merged, [
      { mi: 'VendTableListPage', label: 'All vendors', path: 'Accounts payable > Vendors', aliases: ['Alle Kreditoren'] },
      { mi: 'WHSWaveTemplateTable', label: 'Wave templates' },
    ]);
  });
});
