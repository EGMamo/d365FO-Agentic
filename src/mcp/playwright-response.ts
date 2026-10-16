/**
 * Parsing helpers for Playwright MCP tool results. Every result is markdown with optional
 * sections such as:
 *
 *   ### Ran Playwright code
 *   ```js
 *   await page.getByTestId('SystemDefinedNewButton').click();
 *   ```
 *   ### Page
 *   - Page URL: https://…/?cmp=USMF&mi=VendTableListPage
 *   - Page Title: All vendors -- Finance and Operations
 *
 * The orchestrator reads them to know which F&O form the browser is on and which stable
 * locator an action resolved to, which is what the page map learns from.
 */

/** Joins the text parts of an MCP result; images are handled separately by the caller. */
export function responseText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.filter((p) => p && typeof p === 'object' && (p as { type?: unknown }).type === 'text');
    if (parts.length) return parts.map((p) => String((p as { text?: unknown }).text ?? '')).join('\n');
  }
  return JSON.stringify(content ?? null);
}

export interface PageInfo {
  url?: string;
  title?: string;
}

export function pageInfo(text: string): PageInfo | undefined {
  const url = /^- Page URL: (\S+)\s*$/m.exec(text)?.[1];
  const title = /^- Page Title: (.+?)\s*$/m.exec(text)?.[1];
  return url || title ? { ...(url ? { url } : {}), ...(title ? { title } : {}) } : undefined;
}

/**
 * True while the browser shows F&O's start-up splash ("Finance and Operations / Dynamics 365") after a page load:
 * the URL is already on the F&O host but the client has not set a page title yet. The "Please wait" overlay
 * does not cover this phase, so a wait for that text returns at once on a page that is not usable.
 */
export function isFnoLoading(text: string, baseUrl: string | undefined): boolean {
  const info = pageInfo(text);
  if (!info?.url || info.title || !baseUrl) return false;
  try {
    const base = new URL(/^[a-z][a-z0-9+.-]*:/i.test(baseUrl.trim()) ? baseUrl.trim() : `https://${baseUrl.trim()}`);
    return new URL(info.url).host === base.host;
  } catch {
    return false;
  }
}

/** The `mi=` menu item of an F&O URL, if any. */
export function menuItemOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const mi = new URL(url).searchParams.get('mi') ?? undefined;
    return mi && /^[A-Za-z][A-Za-z0-9_]{1,80}$/.test(mi) ? mi : undefined;
  } catch {
    return undefined;
  }
}

/** "All vendors -- Finance and Operations" → "All vendors". */
export function formCaption(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const caption = title.split(/\s+(?:--|\||–|—)\s+/)[0].trim();
  return caption && caption.length <= 120 ? caption : undefined;
}

const ACTIONS = 'click|dblclick|fill|selectOption|hover|check|uncheck|press|pressSequentially|setChecked';
const RAN_LINE = new RegExp(`^await page\\.(.+)\\.(?:${ACTIONS})\\(.*\\);?\\s*$`);

/**
 * The locators an action resolved to, in order, as Playwright locator code (e.g. `getByTestId('SystemDefinedNewButton')`),
 * which Playwright MCP accepts back as a `target`. Snapshot refs and position-based locators are not
 * stable across page loads and are skipped.
 */
export function ranLocators(text: string): string[] {
  const block = /### Ran Playwright code\s*```[a-z]*\n([\s\S]*?)```/.exec(text)?.[1];
  if (!block) return [];
  const found: string[] = [];
  for (const line of block.split('\n')) {
    const m = RAN_LINE.exec(line.trim());
    if (!m) continue;
    const locator = m[1];
    if (/aria-ref|\.nth\(|\.first\(\)|\.last\(\)/.test(locator) || locator.length > 300) continue;
    found.push(locator);
  }
  return found;
}

/** A snapshot ref such as `e12` or `f1e3` (as opposed to a selector or locator). */
export function isSnapshotRef(target: string): boolean {
  return /^(f\d+)?e\d+$/.test(target.trim());
}

/** The action failed because its selector/ref matched nothing (often: the form had not finished loading). */
export function isMissingTarget(text: string): boolean {
  return /does not match any elements|not found in the current page snapshot/i.test(text);
}

/**
 * Drops anonymous wrapper nodes (`- generic [ref=e12]:` with no name) from an inline accessibility
 * snapshot. F&O nests every control in several of them, so this shrinks snapshots a lot without
 * losing anything a step can act on: named nodes, text and refs of interactive elements stay.
 */
export function slimSnapshot(text: string): string {
  return text.replace(/```yaml\n([\s\S]*?)```/g, (_m, yaml: string) => {
    const kept = yaml.split('\n').filter((line) => !/^\s*- (?:generic|group|none|presentation)(?: \[ref=[\w]+\])?:\s*$/.test(line));
    return `\`\`\`yaml\n${kept.join('\n')}\`\`\``;
  });
}
