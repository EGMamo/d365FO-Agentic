import type { AppConfig } from '../config/index.js';
import { McpManager, type McpServerSpec } from './manager.js';
import { playwrightMcpCommand } from './playwright-browser.js';
import { traceLaunchArgs } from './playwright-trace.js';

/**
 * F&O renders every control with its AOT control name in `data-dyn-controlname` (the name Task Recorder
 * and RSAT record). Making it Playwright's test-id attribute means the locator an action resolves to is
 * `getByTestId('<ControlName>')`: stable across releases, languages and personalisation, so it can be
 * learned once and replayed. F&O also renders slowly, so actions get a longer element timeout.
 */
export function fnoLaunchArgs(cfg: Pick<AppConfig, 'PW_ACTION_TIMEOUT_MS'>): string[] {
  return ['--test-id-attribute', 'data-dyn-controlname', '--timeout-action', String(cfg.PW_ACTION_TIMEOUT_MS ?? 15000)];
}

/**
 * Playwright MCP takes one comma-separated `--caps` list. The testing tools (`browser_verify_*`) are always on: the
 * checks the agent makes with them are recorded and replayed in later runs. Tracing adds devtools.
 */
export function capsArgs(args: string[], base: string[] = ['testing']): string[] {
  const caps = [...base];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--caps' && i + 1 < args.length) caps.push(...args[++i].split(',').filter(Boolean));
    else rest.push(args[i]);
  }
  return ['--caps', Array.from(new Set(caps)).join(','), ...rest];
}

/**
 * Builds the default MCP server registry for the agent. Playwright and Learn
 * are always registered; Release Planner and Azure DevOps MCP are registered only if opted in.
 */
export function buildDefaultManager(cfg: AppConfig, sessionFile?: string): McpManager {
  const manager = new McpManager();

  const playwright: McpServerSpec = {
    name: 'playwright',
    transport: 'stdio',
    ...playwrightMcpCommand([
      ...(cfg.PW_HEADLESS ? ['--headless'] : []),
      '--browser',
      cfg.PW_BROWSER,
      ...fnoLaunchArgs(cfg),
      ...capsArgs(traceLaunchArgs(cfg)),
      // A saved sign-in is loaded into an isolated (in-memory) context; the file itself is never modified.
      ...(sessionFile ? ['--isolated', '--storage-state', sessionFile] : []),
    ]),
  };
  manager.register(playwright);

  const learn: McpServerSpec = {
    name: 'learn',
    transport: 'http',
    url: cfg.LEARN_MCP_URL,
  };
  manager.register(learn);

  if (cfg.RELEASE_PLANNER_MCP_URL) {
    manager.register({ name: 'release-planner', transport: 'http', url: cfg.RELEASE_PLANNER_MCP_URL });
  }

  if (cfg.AZDO_USE_MCP && cfg.AZDO_ORG_URL) {
    manager.register({
      name: 'azure-devops',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@azure-devops/mcp', '--org', cfg.AZDO_ORG_URL],
      env: cfg.AZDO_PAT ? { AZURE_DEVOPS_EXT_PAT: cfg.AZDO_PAT } : undefined,
    });
  }

  return manager;
}
