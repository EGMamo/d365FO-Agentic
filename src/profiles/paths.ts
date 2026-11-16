import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where profiles and UI state live: a per-user config folder outside the repository, so secrets
 * can never be committed by accident. Override with D365FO_AGENT_HOME.
 */
export function agentHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const override = env.D365FO_AGENT_HOME?.trim();
  if (override) return override;
  if (platform === 'win32') return join(env.APPDATA?.trim() || join(home, 'AppData', 'Roaming'), 'd365fo-agent');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'd365fo-agent');
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), 'd365fo-agent');
}

export const profilesDir = (home: string): string => join(home, 'profiles');
export const stateFile = (home: string): string => join(home, 'state.json');
export const tokenFile = (home: string): string => join(home, 'ui-token');
export const serverFile = (home: string): string => join(home, 'ui-server.json');
export const toolTokenFile = (home: string): string => join(home, 'tool-token');
/** The token file used before the Open WebUI runtime was removed. Read once, then migrated. */
export const legacyToolTokenFile = (home: string): string => join(home, 'openwebui-token');
export const modelsDir = (home: string): string => join(home, 'models');
