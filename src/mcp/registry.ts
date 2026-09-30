import type { AppConfig } from '../config/index.js';
import { McpManager, type McpServerSpec } from './manager.js';
import { PLAYWRIGHT_MCP_PACKAGE } from './playwright-browser.js';
import { traceLaunchArgs } from './playwright-trace.js';

/**
 * Builds the default MCP server registry for the agent. Playwright and Learn
 * are always registered; Release Planner and Azure DevOps MCP are registered only if opted in.
 */
export function buildDefaultManager(cfg: AppConfig, sessionFile?: string): McpManager {
  const manager = new McpManager();

  const playwright: McpServerSpec = {
    name: 'playwright',
    transport: 'stdio',
    command: 'npx',
    args: [
      '-y',
      PLAYWRIGHT_MCP_PACKAGE,
      ...(cfg.PW_HEADLESS ? ['--headless'] : []),
      '--browser',
      cfg.PW_BROWSER,
      ...traceLaunchArgs(cfg),
      // A saved sign-in is loaded into an isolated (in-memory) context; the file itself is never modified.
      ...(sessionFile ? ['--isolated', '--storage-state', sessionFile] : []),
    ],
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
