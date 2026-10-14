import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { FIELD_CATALOG, PROVIDER_LABELS } from './catalog.js';
import { checkEntries, ID, isSecretKey, MASK, newId, ProfileError, serialize, type ProfileEntry, type ProfileStore } from './store.js';
import { modelsDir, stateFile } from './paths.js';

/**
 * AI model setups: one connection to a model (provider, key, optional gateway address, model name), set up once and
 * shared by every profile and by the chat. A setup is a file `models/<id>.env` that holds the same settings a profile
 * used to hold for its AI model, so the agent reads it exactly as before; `MODEL_NAME` is the display name and the id
 * in the file name never changes. A profile points to a setup with `AI_MODEL=<id>`.
 */
export const NAME_KEY = 'MODEL_NAME';
export const PROFILE_MODEL_KEY = 'AI_MODEL';
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.()·+-]{0,59}$/;

/** The settings that make up a model setup (the "AI model" group of the form). */
export const MODEL_KEYS = FIELD_CATALOG.filter((f) => f.group === 'AI model').map((f) => f.key);
const MODEL_KEY_SET = new Set([...MODEL_KEYS, 'LLM_MAX_TOKENS']);

export interface ModelSummary {
  id: string;
  name: string;
  provider: string;
  providerLabel: string;
  model: string;
  updatedAt: string;
}

export function validateModelName(name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name.trim()) || /[. ]$/.test(name.trim())) {
    throw new ProfileError('AI model names use letters, digits, spaces and . _ - ( ) + (up to 60 characters).');
  }
  return name.trim();
}

const MODEL_VARIABLE: Record<string, string> = {
  anthropic: 'LLM_MODEL',
  openai: 'OPENAI_MODEL',
  'azure-openai': 'AZURE_OPENAI_DEPLOYMENT',
  'github-models': 'GITHUB_MODELS_MODEL',
  'github-copilot': 'GITHUB_COPILOT_MODEL',
  'openai-compatible': 'OPENAI_COMPATIBLE_MODEL',
};

export class ModelStore {
  constructor(readonly home: string) {}

  private dir = (): string => modelsDir(this.home);
  fileFor = (id: string): string => join(this.dir(), `${id}.env`);

  private async ids(): Promise<string[]> {
    try {
      return (await readdir(this.dir())).filter((f) => f.endsWith('.env')).map((f) => f.slice(0, -4)).filter((i) => ID.test(i));
    } catch {
      return [];
    }
  }

  async list(): Promise<ModelSummary[]> {
    const out: ModelSummary[] = [];
    for (const id of await this.ids()) {
      const entries = await this.read(id, true).catch(() => undefined);
      if (!entries) continue;
      const v = (k: string): string => entries.find((e) => e.key === k)?.value ?? '';
      const provider = v('LLM_PROVIDER') || 'anthropic';
      out.push({
        id,
        name: v(NAME_KEY) || id,
        provider,
        providerLabel: PROVIDER_LABELS[provider] ?? provider,
        model: v(MODEL_VARIABLE[provider] ?? 'LLM_MODEL'),
        updatedAt: (await stat(this.fileFor(id))).mtime.toISOString(),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A setup by its id or, failing that, its name (any letter case). */
  async find(ref: string): Promise<ModelSummary | undefined> {
    const all = await this.list();
    const r = ref.trim().toLowerCase();
    return all.find((m) => m.id === r) ?? all.find((m) => m.name.toLowerCase() === r);
  }

  /** Settings of a setup, without its name. Secrets are masked unless `reveal` is set. */
  async read(id: string, reveal = false): Promise<ProfileEntry[]> {
    if (!ID.test(id)) throw new ProfileError(`No AI model "${id}".`, 404);
    let text: string;
    try {
      text = await readFile(this.fileFor(id), 'utf8');
    } catch {
      throw new ProfileError(`No AI model "${id}".`, 404);
    }
    const parsed = dotenv.parse(text);
    const order = [...text.matchAll(/^\s*([A-Za-z_]\w*)\s*=/gm)].map((m) => m[1]).filter((k, i, a) => a.indexOf(k) === i && k in parsed);
    return order.map((key) => ({ key, value: !reveal && isSecretKey(key) && parsed[key] ? MASK : parsed[key] }));
  }

  async name(id: string): Promise<string> {
    return (await this.read(id, true)).find((e) => e.key === NAME_KEY)?.value || id;
  }

  /** Creates a setup (no id) or replaces one. A secret sent back as MASK keeps the stored value. Returns the id. */
  async write(id: string | undefined, name: unknown, entries: unknown): Promise<string> {
    const clean = validateModelName(name);
    const checked = checkEntries(entries).filter((e) => e.key !== NAME_KEY && MODEL_KEY_SET.has(e.key));
    for (const m of await this.list()) if (m.name.toLowerCase() === clean.toLowerCase() && m.id !== id) throw new ProfileError(`An AI model named "${m.name}" already exists.`, 409);
    let old = new Map<string, string>();
    if (id) old = new Map((await this.read(id, true)).map((e) => [e.key, e.value]));
    else id = newId();
    const final = checked.map((e) => (e.value === MASK && isSecretKey(e.key) ? { key: e.key, value: old.get(e.key) ?? '' } : e)).filter((e) => !(isSecretKey(e.key) && e.value === MASK));
    await mkdir(this.dir(), { recursive: true, mode: 0o700 });
    const target = this.fileFor(id);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, serialize([{ key: NAME_KEY, value: clean }, ...final]), { mode: 0o600 });
    await rename(tmp, target);
    await chmod(target, 0o600).catch(() => undefined);
    return id;
  }

  async rename(id: string, name: unknown): Promise<void> {
    await this.write(id, name, (await this.read(id, true)).filter((e) => e.key !== NAME_KEY));
  }

  async duplicate(id: string, name: unknown): Promise<string> {
    return this.write(undefined, name, (await this.read(id, true)).filter((e) => e.key !== NAME_KEY));
  }

  /** Profiles that point to this setup, and whether the chat uses it. */
  async usedBy(id: string, profiles: ProfileStore): Promise<{ profiles: string[]; chat: boolean }> {
    const used: string[] = [];
    for (const p of await profiles.list()) {
      const entries = await profiles.read(p.name, true).catch(() => []);
      if (entries.find((e) => e.key === PROFILE_MODEL_KEY)?.value === id) used.push(p.name);
    }
    return { profiles: used, chat: (await this.getChat()) === id };
  }

  async delete(id: string, profiles: ProfileStore): Promise<void> {
    if (!ID.test(id)) throw new ProfileError(`No AI model "${id}".`, 404);
    const use = await this.usedBy(id, profiles);
    if (use.profiles.length || use.chat) {
      throw new ProfileError(`"${await this.name(id)}" is in use by ${[...use.profiles.map((p) => `profile ${p}`), ...(use.chat ? ['the chat'] : [])].join(' and ')}. Pick another AI model there first.`, 409);
    }
    await rm(this.fileFor(id));
  }

  private async state(): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await readFile(stateFile(this.home), 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** Result of the last "Test connection" of each setup. */
  async getChecks(): Promise<Record<string, { ok: boolean; detail: string; at: string }>> {
    const checks = (await this.state()).modelChecks;
    return checks && typeof checks === 'object' ? (checks as Record<string, { ok: boolean; detail: string; at: string }>) : {};
  }

  async setCheck(id: string, result: { ok: boolean; detail: string; at: string } | undefined): Promise<void> {
    const { [id]: _old, ...rest } = await this.getChecks();
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await writeFile(stateFile(this.home), JSON.stringify({ ...(await this.state()), modelChecks: result ? { ...rest, [id]: result } : rest }), { mode: 0o600 });
  }

  /** The setup the chat uses (the same for every profile); the first one when none was chosen. */
  async getChat(): Promise<string | undefined> {
    const chosen = (await this.state()).chatModel;
    if (typeof chosen === 'string' && ID.test(chosen) && (await this.ids()).includes(chosen)) return chosen;
    return (await this.list())[0]?.id;
  }

  async setChat(id: string | undefined): Promise<void> {
    if (id !== undefined && !(await this.ids()).includes(id)) throw new ProfileError(`No AI model "${id}".`, 404);
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await writeFile(stateFile(this.home), JSON.stringify({ ...(await this.state()), chatModel: id ?? null }), { mode: 0o600 });
  }
}

/**
 * Moves the AI model settings out of profiles into shared setups. Each profile's model settings become a setup (two
 * profiles with the same settings share one) and the profile points to it. Profiles already pointing to a setup, and
 * profiles with no model settings, are left alone.
 */
export async function migrateProfileModels(profiles: ProfileStore, models: ModelStore): Promise<number> {
  let moved = 0;
  const known = await models.list();
  const signature = (entries: ProfileEntry[]): string => JSON.stringify([...entries].sort((a, b) => a.key.localeCompare(b.key)).map((e) => [e.key, e.value]));
  const made = new Map<string, string>();
  for (const m of known) made.set(signature((await models.read(m.id, true)).filter((e) => e.key !== NAME_KEY)), m.id);
  for (const p of await profiles.list()) {
    const entries = await profiles.read(p.name, true);
    if (entries.some((e) => e.key === PROFILE_MODEL_KEY)) continue;
    const modelEntries = entries.filter((e) => MODEL_KEY_SET.has(e.key) && e.value !== '');
    if (!modelEntries.length) continue;
    const sig = signature(modelEntries);
    let id = made.get(sig);
    if (!id) {
      const provider = modelEntries.find((e) => e.key === 'LLM_PROVIDER')?.value || 'anthropic';
      const model = modelEntries.find((e) => e.key === MODEL_VARIABLE[provider])?.value;
      const base = `${PROVIDER_LABELS[provider]?.split(' (')[0] ?? provider}${model ? ` · ${model}` : ''}`.slice(0, 54);
      let name = base;
      for (let n = 2; (await models.list()).some((m) => m.name.toLowerCase() === name.toLowerCase()); n++) name = `${base} (${n})`;
      id = await models.write(undefined, name, modelEntries);
      made.set(sig, id);
    }
    await profiles.write(p.name, [...entries.filter((e) => !MODEL_KEY_SET.has(e.key)), { key: PROFILE_MODEL_KEY, value: id }], 'replace');
    moved++;
  }
  return moved;
}
