import type { AppConfig } from '../config/index.js';
import { checkNavigation } from '../d365fo/environment.js';

/**
 * Code-level tool policy. The model is only shown tools on this allowlist and any
 * call to another tool is refused at dispatch, so a prompt-injected page or a
 * hallucinated tool name cannot reach the rest of what an MCP server exposes
 * (the Playwright server alone ships cookie/storage dumps, arbitrary JS and file access).
 *
 * Anything else has to be opted into with AGENT_ALLOWED_TOOLS_EXTRA, using the
 * `<server>__<tool>` names the model sees; a trailing `*` matches a prefix.
 */
const DEFAULT_ALLOWED_TOOLS: Record<string, readonly string[]> = {
  playwright: [
    'browser_navigate',
    'browser_navigate_back',
    'browser_snapshot',
    'browser_take_screenshot',
    'browser_click',
    'browser_hover',
    'browser_type',
    'browser_fill_form',
    'browser_press_key',
    'browser_select_option',
    'browser_drag',
    'browser_wait_for',
    'browser_tabs',
    'browser_handle_dialog',
    'browser_console_messages',
    'browser_resize',
    'browser_close',
    'browser_find',
    'browser_verify_element_visible',
    'browser_verify_list_visible',
    'browser_verify_text_visible',
    'browser_verify_value',
  ],
  learn: ['microsoft_docs_search', 'microsoft_docs_fetch', 'microsoft_code_sample_search'],
  // Read-only queries of Microsoft's public release plans (FastTrack Release Planner MCP sample).
};

type GuardrailConfig = Pick<AppConfig, 'D365_BASE_URL' | 'D365_COMPANY'> &
  Partial<Pick<AppConfig, 'AGENT_ALLOWED_TOOLS_EXTRA' | 'AGENT_ALLOWED_HOSTS'>>;

export class Guardrails {
  private readonly extra: string[];

  constructor(
    private readonly cfg: GuardrailConfig,
    private readonly servers: readonly string[],
  ) {
    this.extra = cfg.AGENT_ALLOWED_TOOLS_EXTRA ?? [];
  }

  isToolAllowed(server: string, tool: string): boolean {
    if (DEFAULT_ALLOWED_TOOLS[server]?.includes(tool)) return true;
    const name = `${server}__${tool}`;
    return this.extra.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
  }

  /** Splits discovered MCP tools into those the model may see and those that are hidden. */
  splitTools<T extends { server: string; name: string }>(tools: T[]): { allowed: T[]; blocked: T[] } {
    const allowed: T[] = [];
    const blocked: T[] = [];
    for (const t of tools) (this.isToolAllowed(t.server, t.name) ? allowed : blocked).push(t);
    return { allowed, blocked };
  }

  /** Returns why an MCP tool call must be refused, or undefined when it may proceed. */
  checkCall(server: string, tool: string, args: Record<string, unknown>, legalEntity?: string): string | undefined {
    if (!this.servers.includes(server)) return `MCP server '${server}' is not enabled for this run`;
    if (!this.isToolAllowed(server, tool)) return `tool '${server}__${tool}' is not on the agent's tool allowlist`;
    if (server === 'playwright' && typeof args.url === 'string') {
      return checkNavigation(this.cfg, args.url, legalEntity ?? this.cfg.D365_COMPANY);
    }
    return undefined;
  }
}
