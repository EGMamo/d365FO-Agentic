import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BUILTIN_MENU_ITEMS, loadMenuItems, menuItemUrl, resolveMenuItem } from './navigation.js';

describe('menu item navigation', () => {
  it('resolves captions, module paths, aliases and names to one menu item', () => {
    for (const q of ['All vendors', 'Modules > Accounts payable > Vendors > All vendors', 'vendors', 'vendtablelistpage']) {
      const m = resolveMenuItem(BUILTIN_MENU_ITEMS, q);
      assert.ok('item' in m, q);
      assert.equal(m.item.mi, 'VendTableListPage');
    }
  });

  it('returns candidates instead of guessing when a name is ambiguous or unknown', () => {
    const amb = resolveMenuItem(BUILTIN_MENU_ITEMS, 'all');
    assert.ok('candidates' in amb && amb.candidates.length > 1);
    const none = resolveMenuItem(BUILTIN_MENU_ITEMS, 'Warehouse wave templates');
    assert.deepEqual(none, { candidates: [] });
  });

  it('builds a deep link with the company and menu item, keeping the base path', () => {
    assert.equal(menuItemUrl('https://fo.sandbox.operations.dynamics.com/', 'USMF', 'CustTableListPage'), 'https://fo.sandbox.operations.dynamics.com/?cmp=USMF&mi=CustTableListPage');
    assert.equal(menuItemUrl('fo.cloudax.dynamics.com/namespaces/AXSF?cmp=DEMF', 'USMF', 'X1'), 'https://fo.cloudax.dynamics.com/namespaces/AXSF?cmp=USMF&mi=X1');
  });

  it('adds valid entries from menu-items.json and overrides built-ins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mi-'));
    await writeFile(join(dir, 'menu-items.json'), JSON.stringify([
      { mi: 'WHSWaveTemplateTable', label: 'Wave templates', path: 'Warehouse management > Setup > Waves' },
      { mi: 'VendTableListPage', label: 'Lieferanten' },
      { mi: 'bad name;', label: 'x' },
      { label: 'no mi' },
    ]));
    const items = await loadMenuItems(dir);
    assert.equal(items.length, BUILTIN_MENU_ITEMS.length + 1);
    assert.equal(items.find((m) => m.mi === 'VendTableListPage')?.label, 'Lieferanten');
    const m = resolveMenuItem(items, 'wave templates');
    assert.ok('item' in m && m.item.mi === 'WHSWaveTemplateTable');
  });
});
