import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { AI_KEYS } from '../profiles/ai.js';
import { agentHome, profilesDir, stateFile } from '../profiles/paths.js';

/**
 * Loads settings before the config is read. When a profile is selected (D365FO_PROFILE, `--profile <name>`, or the one
 * chosen in the web UI) its file is used instead of `.env`; otherwise `.env` in the working directory, as before.
 * Variables already set in the real environment always win.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/;

export interface ProfileSelection {
  name?: string;
  source: 'env' | 'argv' | 'ui' | 'run' | 'none';
  /** A profile was asked for but its file does not exist, so `.env` is used. */
  missing?: string;
}

function argvValue(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag) return argv[i + 1];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}
const fromArgv = (argv: string[]): string | undefined => argvValue(argv, '--profile');

const ID = /^[a-z0-9]{8,32}$/;

/** Files in a settings folder whose text has the line `KEY=value`, for finding a profile by its permanent id. */
function fileWith(dir: string, key: string, value: string): string | undefined {
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.env')) continue;
      const text = readFileSync(join(dir, f), 'utf8');
      if (new RegExp(`^\\s*${key}\\s*=\\s*['"\\x60]?${value}['"\\x60]?\\s*$`, 'm').test(text)) return f.slice(0, -4);
    }
  } catch {
    /* no such folder */
  }
  return undefined;
}

export function selectProfile(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): ProfileSelection {
  const home = agentHome(env);
  const asked = fromArgv(argv) ?? env.D365FO_PROFILE;
  const source: ProfileSelection['source'] = fromArgv(argv) !== undefined ? 'argv' : 'env';
  const pick = (name: string, src: ProfileSelection['source']): ProfileSelection => {
    if (NAME.test(name) && existsSync(join(profilesDir(home), `${name}.env`))) return { name, source: src };
    // A profile can also be named by its permanent id, which does not change when it is renamed.
    const byId = ID.test(name) ? fileWith(profilesDir(home), 'PROFILE_ID', name) : undefined;
    return byId ? { name: byId, source: src } : { source: 'none', missing: name };
  };
  if (asked !== undefined) return asked.trim() === '' || asked.trim().toLowerCase() === 'none' ? { source: 'none' } : pick(asked.trim(), source);
  // Uploading a saved run uses the profile that run belongs to, not the one picked in the app now.
  const input = argv.includes('upload') ? argvValue(argv, '--input') : undefined;
  if (input) {
    try {
      const meta = JSON.parse(readFileSync(join(dirname(resolve(input)), 'meta.json'), 'utf8')) as { profile?: unknown; profileId?: unknown };
      for (const ref of [meta.profileId, meta.profile]) {
        const sel = typeof ref === 'string' && ref ? pick(ref, 'run') : undefined;
        if (sel?.name) return sel;
      }
    } catch {
      /* not a run from the history */
    }
  }
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

// The shared connection overrides legacy per-profile model fields; genuine process variables still win.
export const modelSelection = { name: 'Shared Claude connection', id: 'shared' };
const sharedFile = join(agentHome(), 'ai.env');
if (existsSync(sharedFile)) {
  const shared = dotenv.parse(readFileSync(sharedFile, 'utf8'));
  loaded = Object.fromEntries(Object.entries(loaded ?? {}).filter(([key]) => !(AI_KEYS as readonly string[]).includes(key)));
  for (const key of AI_KEYS) if (!presetKeys.has(key)) delete process.env[key];
  loaded = { ...loaded, ...shared };
  for (const [key, value] of Object.entries(shared)) if (!presetKeys.has(key)) process.env[key] = value;
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
