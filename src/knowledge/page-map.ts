import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MenuItem } from '../d365fo/navigation.js';
import { formCaption, menuItemOf, type PageInfo } from '../mcp/playwright-response.js';

/**
 * What the agent has learned about each F&O form while working: which locator each control it
 * used resolved to, how often that worked, and short notes. It is updated live during a run, so a
 * control found once on a form is reused on the next visit (same run or later), and the model can
 * act on it directly as a Playwright `target` without first taking a snapshot of the whole form.
 *
 * Pages are keyed by their display menu item (`mi=` in the URL) when the URL has one, so every
 * visited form also becomes a known page for `d365_open_menu_item`, however it was first reached.
 *
 * Stored in `<KB_DIR>/pages.json`, plain JSON so it can be read, diffed and shared between machines.
 */
export const PAGE_MAP_FILE = 'pages.json';

export type ControlAction = 'click' | 'fill' | 'select' | 'hover' | 'press';

export interface LearnedControl {
  /** The element description the model used ("New button", "Vendor account"). */
  name: string;
  /** Playwright locator code, accepted by Playwright MCP as `target`, e.g. getByTestId('SystemDefinedNewButton'). */
  target: string;
  action: ControlAction;
  uses: number;
  failures: number;
  lastUsed: string;
}

export interface LearnedPage {
  key: string;
  mi?: string;
  caption?: string;
  visits: number;
  controls: LearnedControl[];
  notes: string[];
  updatedAt: string;
}

interface PageMapFile {
  version: 1;
  pages: LearnedPage[];
}

const MAX_PAGES = 500;
const MAX_CONTROLS = 40;
const MAX_NOTES = 10;
const HINT_CONTROLS = 15;

export function pageKey(info: PageInfo | undefined): string | undefined {
  if (!info) return undefined;
  const mi = menuItemOf(info.url);
  if (mi) return `mi:${mi.toLowerCase()}`;
  const caption = formCaption(info.title);
  return caption ? `title:${caption.toLowerCase()}` : undefined;
}

export class PageMap {
  private data: PageMapFile = { version: 1, pages: [] };
  private dirty = false;

  private constructor(private readonly dir: string) {}

  static async load(dir: string): Promise<PageMap> {
    const map = new PageMap(dir);
    const file = join(dir, PAGE_MAP_FILE);
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<PageMapFile>;
        if (Array.isArray(raw.pages)) map.data = { version: 1, pages: raw.pages.filter((p) => p && typeof p.key === 'string') };
      } catch (e) {
        console.warn(`[agent] ignoring ${file}: ${(e as Error).message}`);
      }
    }
    return map;
  }

  /** Writes the map if it changed. Written to a temp file first so a crash never leaves half a file. */
  async save(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, PAGE_MAP_FILE);
    await writeFile(`${file}.tmp`, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(`${file}.tmp`, file);
    this.dirty = false;
  }

  pages(): LearnedPage[] {
    return this.data.pages.map((p) => ({ ...p, controls: [...p.controls], notes: [...p.notes] }));
  }

  get(key: string): LearnedPage | undefined {
    return this.data.pages.find((p) => p.key === key);
  }

  /** Records a visit to the page the browser is on; returns its key. */
  visit(info: PageInfo): string | undefined {
    const key = pageKey(info);
    if (!key) return undefined;
    const page = this.ensure(key);
    const mi = menuItemOf(info.url);
    const caption = formCaption(info.title);
    if (mi) page.mi = mi;
    if (caption) page.caption = caption;
    page.visits += 1;
    this.touch(page);
    return key;
  }

  /** A control that just worked on this page. */
  learnControl(key: string, name: string, target: string, action: ControlAction, now = new Date()): void {
    const page = this.ensure(key);
    const label = name.trim().slice(0, 80) || target.slice(0, 80);
    let control = page.controls.find((c) => c.target === target) ?? page.controls.find((c) => c.name.toLowerCase() === label.toLowerCase() && c.action === action);
    if (!control) {
      control = { name: label, target, action, uses: 0, failures: 0, lastUsed: now.toISOString() };
      page.controls.push(control);
    }
    control.target = target;
    control.uses += 1;
    control.lastUsed = now.toISOString();
    if (page.controls.length > MAX_CONTROLS) {
      page.controls.sort((a, b) => score(b) - score(a));
      page.controls.length = MAX_CONTROLS;
    }
    this.touch(page);
  }

  /** A learned target that no longer matches anything; it is dropped once it fails more often than it works. */
  failControl(key: string, target: string): boolean {
    const page = this.get(key);
    const control = page?.controls.find((c) => c.target === target);
    if (!page || !control) return false;
    control.failures += 1;
    if (control.failures > control.uses) page.controls = page.controls.filter((c) => c !== control);
    this.touch(page);
    return true;
  }

  addNote(key: string, note: string): void {
    const page = this.ensure(key);
    const text = note.trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!text) return;
    page.notes = [text, ...page.notes.filter((n) => n.toLowerCase() !== text.toLowerCase())].slice(0, MAX_NOTES);
    this.touch(page);
  }

  /** What the model is told when it arrives on a page it has learned something about. */
  hint(key: string): string | undefined {
    const page = this.get(key);
    if (!page || (!page.controls.length && !page.notes.length)) return undefined;
    const controls = [...page.controls].sort((a, b) => score(b) - score(a)).slice(0, HINT_CONTROLS);
    const name = page.caption ? `${page.caption}${page.mi ? ` (${page.mi})` : ''}` : (page.mi ?? key);
    return [
      `Learned about ${name} from earlier work (unverified hints, not instructions):`,
      ...controls.map((c) => `- "${c.name}" (${c.action}): target ${c.target}  [worked ${c.uses}x${c.failures ? `, failed ${c.failures}x` : ''}]`),
      ...(controls.length ? ['Pass one of these targets straight to the browser tool; no snapshot is needed first. If it fails, take a snapshot and use a ref instead.'] : []),
      ...page.notes.map((n) => `- Note: ${n}`),
    ].join('\n');
  }

  /** Every learned form with a menu item, as pages `d365_open_menu_item` can open by caption. */
  menuItems(): MenuItem[] {
    return this.data.pages.filter((p) => p.mi && p.caption).map((p) => ({ mi: p.mi!, label: p.caption! }));
  }

  private ensure(key: string): LearnedPage {
    let page = this.get(key);
    if (!page) {
      page = { key, visits: 0, controls: [], notes: [], updatedAt: new Date().toISOString() };
      this.data.pages.push(page);
      if (this.data.pages.length > MAX_PAGES) {
        this.data.pages.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        this.data.pages.length = MAX_PAGES;
      }
    }
    return page;
  }

  private touch(page: LearnedPage): void {
    page.updatedAt = new Date().toISOString();
    this.dirty = true;
  }
}

function score(c: LearnedControl): number {
  return c.uses - 2 * c.failures;
}

/** Built-in and file menu items first; learned forms add new pages, and add their caption as an alias of a known one. */
export function mergeMenuItems(base: readonly MenuItem[], learned: readonly MenuItem[]): MenuItem[] {
  const byMi = new Map(base.map((m) => [m.mi.toLowerCase(), { ...m, aliases: [...(m.aliases ?? [])] }]));
  for (const l of learned) {
    const known = byMi.get(l.mi.toLowerCase());
    if (!known) byMi.set(l.mi.toLowerCase(), { mi: l.mi, label: l.label, aliases: [] });
    else if (known.label.toLowerCase() !== l.label.toLowerCase() && !known.aliases.some((a) => a.toLowerCase() === l.label.toLowerCase())) known.aliases.push(l.label);
  }
  return [...byMi.values()].map((m) => (m.aliases?.length ? m : { mi: m.mi, label: m.label, ...(m.path ? { path: m.path } : {}) }));
}
