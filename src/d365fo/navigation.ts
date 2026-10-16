import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LlmTool } from '../llm/types.js';

/**
 * Direct navigation to F&O pages by display menu item. Every F&O form can be opened
 * with `<base>/?cmp=<company>&mi=<MenuItemName>`, which skips the navigation pane and
 * the search box: one page load instead of five to ten clicks and snapshots, and no
 * dependence on menu captions that change between releases or languages.
 */
export interface MenuItem {
  /** Display menu item name, the `mi=` value in the page URL (e.g. VendTableListPage). */
  mi: string;
  /** Caption shown in the navigation pane (e.g. "All vendors"). */
  label: string;
  /** Module path in the navigation pane, for humans and for matching (e.g. "Accounts payable > Vendors"). */
  path?: string;
  aliases?: string[];
}

/** Standard F&O menu items most test cases start from. Extend it per environment with `<KB_DIR>/menu-items.json`. */
export const BUILTIN_MENU_ITEMS: readonly MenuItem[] = [
  { mi: 'DefaultDashboard', label: 'Dashboard', aliases: ['home'] },
  { mi: 'VendTableListPage', label: 'All vendors', path: 'Accounts payable > Vendors', aliases: ['vendors'] },
  { mi: 'VendInvoiceInfoListPage', label: 'Pending vendor invoices', path: 'Accounts payable > Invoices', aliases: ['vendor invoices'] },
  { mi: 'CustTableListPage', label: 'All customers', path: 'Accounts receivable > Customers', aliases: ['customers'] },
  { mi: 'SalesTableListPage', label: 'All sales orders', path: 'Sales and marketing > Sales orders', aliases: ['sales orders'] },
  { mi: 'PurchTableListPage', label: 'All purchase orders', path: 'Procurement and sourcing > Purchase orders', aliases: ['purchase orders'] },
  { mi: 'EcoResProductPerCompanyListPage', label: 'Released products', path: 'Product information management > Products', aliases: ['items'] },
  { mi: 'EcoResProductListPage', label: 'All products and product masters', path: 'Product information management > Products', aliases: ['products'] },
  { mi: 'MainAccountListPage', label: 'Main accounts', path: 'General ledger > Chart of accounts > Accounts' },
  { mi: 'LedgerJournalTable5', label: 'General journals', path: 'General ledger > Journal entries' },
  { mi: 'ProjProjectsListPage', label: 'All projects', path: 'Project management and accounting > Projects', aliases: ['projects'] },
  { mi: 'SysUserManagement', label: 'Users', path: 'System administration > Users' },
];

const MI_NAME = /^[A-Za-z][A-Za-z0-9_]{1,80}$/;

export const MENU_ITEM_FILE = 'menu-items.json';

/** Built-in items plus `<KB_DIR>/menu-items.json` (an array of MenuItem). Entries in the file win over built-ins with the same `mi`. */
export async function loadMenuItems(kbDir: string): Promise<MenuItem[]> {
  const byMi = new Map(BUILTIN_MENU_ITEMS.map((m) => [m.mi.toLowerCase(), m]));
  const file = join(kbDir, MENU_ITEM_FILE);
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
      for (const e of Array.isArray(raw) ? raw : []) {
        const m = e as Partial<MenuItem>;
        if (typeof m?.mi !== 'string' || !MI_NAME.test(m.mi) || typeof m.label !== 'string' || !m.label.trim()) continue;
        byMi.set(m.mi.toLowerCase(), {
          mi: m.mi,
          label: m.label.trim(),
          ...(typeof m.path === 'string' && m.path.trim() ? { path: m.path.trim() } : {}),
          ...(Array.isArray(m.aliases) ? { aliases: m.aliases.filter((a): a is string => typeof a === 'string') } : {}),
        });
      }
    } catch (e) {
      console.warn(`[agent] ignoring ${file}: ${(e as Error).message}`);
    }
  }
  return [...byMi.values()];
}

/**
 * Captions F&O shows in English (United Kingdom) for the US terms the menu items are listed under, so a step
 * written against a UK client ("Purchase ledger > Suppliers > All suppliers") finds the same page.
 */
const UK_TERMS: ReadonlyArray<[RegExp, string]> = [
  [/\bpurchase ledger\b/g, 'accounts payable'],
  [/\bsales ledger\b/g, 'accounts receivable'],
  [/\bsuppliers\b/g, 'vendors'],
  [/\bsupplier\b/g, 'vendor'],
];

function norm(s: string): string {
  return UK_TERMS.reduce((t, [uk, us]) => t.replace(uk, us), s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
}

export type MenuItemMatch = { item: MenuItem } | { candidates: MenuItem[] };

/**
 * Finds the menu item for a model-supplied name: an exact menu item name, caption, alias
 * or "path > caption" first, then a unique partial match. Several or no partial matches
 * return candidates instead of guessing.
 */
export function resolveMenuItem(items: readonly MenuItem[], query: string): MenuItemMatch {
  const q = norm(query);
  if (!q) return { candidates: [] };
  const names = (m: MenuItem) => [m.mi, m.label, ...(m.aliases ?? []), ...(m.path ? [`${m.path} > ${m.label}`] : [])].map(norm);
  const exact = items.filter((m) => names(m).includes(q));
  if (exact.length === 1) return { item: exact[0] };
  const partial = exact.length ? exact : items.filter((m) => names(m).some((n) => n.includes(q) || q.endsWith(n)));
  return partial.length === 1 ? { item: partial[0] } : { candidates: partial.slice(0, 8) };
}

/** True when `name` can be used as a raw `mi=` value. */
export function isMenuItemName(name: string): boolean {
  return MI_NAME.test(name);
}

/** The deep link that opens `mi` in `company`, keeping any path on the base URL. */
export function menuItemUrl(baseUrl: string, company: string, mi: string): string {
  const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(baseUrl.trim()) ? baseUrl.trim() : `https://${baseUrl.trim()}`);
  url.searchParams.set('cmp', company);
  url.searchParams.set('mi', mi);
  return url.toString();
}

export const OPEN_MENU_ITEM_TOOL_NAME = 'd365_open_menu_item';

export function openMenuItemTool(items: readonly MenuItem[]): LlmTool {
  const known = items.map((m) => `${m.label} (${m.mi})`).join('; ');
  return {
    name: OPEN_MENU_ITEM_TOOL_NAME,
    description:
      'Open an F&O page directly by its menu item, in the test\'s legal entity, and return a snapshot once it has loaded. ' +
      'Much faster and more reliable than the navigation pane or search box: use it whenever a step names a page. ' +
      `Known pages: ${known}. ` +
      'Pass the caption, the module path ("Accounts payable > Vendors > All vendors") or the menu item name. ' +
      'A page not in the list can still be opened with its menu item name (the `mi=` value in that page\'s URL) via `menuItem`.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Caption or module path of the page, e.g. "All vendors"' },
        menuItem: { type: 'string', description: 'Display menu item name, e.g. "VendTableListPage"' },
      },
    },
  };
}
