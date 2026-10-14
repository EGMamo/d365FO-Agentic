import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { agentHome, modelsDir, profilesDir, stateFile } from '../profiles/paths.js';

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

export interface ModelSelection {
  id?: string;
  name?: string;
  /** Where the choice came from: `--model`, D365FO_MODEL, or the AI model the profile points to. */
  source: 'argv' | 'env' | 'profile' | 'none';
  /** An AI model was asked for but no setup matches it. */
  missing?: string;
}

/** Finds an AI model setup by id or, failing that, by name (any letter case). */
export function findModel(home: string, ref: string): { id: string; name: string } | undefined {
  const dir = modelsDir(home);
  const read = (id: string): { id: string; name: string } | undefined => {
    try {
      const parsed = dotenv.parse(readFileSync(join(dir, `${id}.env`), 'utf8'));
      return { id, name: parsed.MODEL_NAME || id };
    } catch {
      return undefined;
    }
  };
  const wanted = ref.trim();
  if (ID.test(wanted) && existsSync(join(dir, `${wanted}.env`))) return read(wanted);
  try {
    for (const f of readdirSync(dir)) {
      const m = f.endsWith('.env') && ID.test(f.slice(0, -4)) ? read(f.slice(0, -4)) : undefined;
      if (m && m.name.toLowerCase() === wanted.toLowerCase()) return m;
    }
  } catch {
    /* no setups yet */
  }
  return undefined;
}

export function selectModel(env: NodeJS.ProcessEnv, argv: string[], profileModel: string | undefined): ModelSelection {
  const asked = argvValue(argv, '--model');
  const [ref, source] = asked !== undefined ? [asked, 'argv' as const] : env.D365FO_MODEL?.trim() ? [env.D365FO_MODEL, 'env' as const] : profileModel?.trim() ? [profileModel, 'profile' as const] : [undefined, 'none' as const];
  if (ref === undefined) return { source: 'none' };
  const found = findModel(agentHome(env), ref);
  return found ? { ...found, source } : { source, missing: ref.trim() };
}

/**
 * The AI model setup the profile points to (`AI_MODEL`), or the one asked for with `--model` / D365FO_MODEL, which wins
 * for this run only. Its settings are read as if they were in the profile. A setting in the real environment still wins.
 */
export const modelSelection = selectModel(process.env, process.argv, loaded?.AI_MODEL);
if (modelSelection.missing) console.warn(`[config] AI model "${modelSelection.missing}" was not found; using the model settings of the profile or .env`);
if (modelSelection.id) {
  const fromModel = dotenv.parse(readFileSync(join(modelsDir(agentHome()), `${modelSelection.id}.env`), 'utf8'));
  delete fromModel.MODEL_NAME;
  loaded = { ...(loaded ?? {}) };
  for (const [k, v] of Object.entries(fromModel)) {
    // `--model` replaces what the profile says; the profile's own model, when it has one, otherwise wins as before.
    if (presetKeys.has(k)) continue;
    if (modelSelection.source !== 'profile' || process.env[k] === undefined) {
      process.env[k] = v;
      loaded[k] = v;
    }
  }
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
