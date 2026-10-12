import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { agentHome, profilesDir, stateFile } from '../profiles/paths.js';

/**
 * Loads settings before the config is read. When a profile is selected (D365FO_PROFILE, `--profile <name>`, or the one
 * chosen in the web UI) its file is used instead of `.env`; otherwise `.env` in the working directory, as before.
 * Variables already set in the real environment always win.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/;

export interface ProfileSelection {
  name?: string;
  source: 'env' | 'argv' | 'ui' | 'none';
  /** A profile was asked for but its file does not exist, so `.env` is used. */
  missing?: string;
}

function fromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') return argv[i + 1];
    if (a.startsWith('--profile=')) return a.slice('--profile='.length);
  }
  return undefined;
}

export function selectProfile(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): ProfileSelection {
  const home = agentHome(env);
  const asked = fromArgv(argv) ?? env.D365FO_PROFILE;
  const source: ProfileSelection['source'] = fromArgv(argv) !== undefined ? 'argv' : 'env';
  const pick = (name: string, src: ProfileSelection['source']): ProfileSelection => {
    if (!NAME.test(name)) return { source: 'none', missing: name };
    return existsSync(join(profilesDir(home), `${name}.env`)) ? { name, source: src } : { source: 'none', missing: name };
  };
  if (asked !== undefined) return asked.trim() === '' || asked.trim().toLowerCase() === 'none' ? { source: 'none' } : pick(asked.trim(), source);
  try {
    const { active } = JSON.parse(readFileSync(stateFile(home), 'utf8')) as { active?: unknown };
    if (typeof active === 'string') {
      const sel = pick(active, 'ui');
      return sel.name ? sel : { source: 'none' };
    }
  } catch {
    /* no state yet */
  }
  return { source: 'none' };
}

export const profileSelection = selectProfile();

const presetKeys = new Set(Object.keys(process.env));
let loaded: Record<string, string> | undefined;
if (profileSelection.name) {
  loaded = dotenv.config({ path: join(profilesDir(agentHome()), `${profileSelection.name}.env`) }).parsed;
} else {
  if (profileSelection.missing) console.warn(`[config] profile "${profileSelection.missing}" was not found; using .env`);
  loaded = dotenv.config().parsed;
}

/** Variables this process took from its settings file (a profile or `.env`), as opposed to its real environment. */
export const loadedKeys: readonly string[] = Object.keys(loaded ?? {}).filter((k) => !presetKeys.has(k));

/**
 * Settings in the file that did not take effect because the real environment already had a different value.
 * `doctor` lists them, since a profile that is quietly overridden is hard to spot.
 */
export const overriddenKeys: readonly string[] = Object.entries(loaded ?? {})
  .filter(([k, v]) => presetKeys.has(k) && process.env[k] !== v)
  .map(([k]) => k);

/**
 * The environment to give a child command that must read its own settings (another profile, or `.env` afresh).
 * Without this, what this process loaded would look like real environment variables to the child and, because
 * those always win, silently override the profile the child was asked to use.
 */
export function environmentForChild(env: NodeJS.ProcessEnv = process.env, fromFile: readonly string[] = loadedKeys): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of fromFile) delete out[k];
  return out;
}
