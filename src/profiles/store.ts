import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { SECRET_NAME } from '../config/dotenv-check.js';
import { profilesDir, stateFile } from './paths.js';

/** Sent in place of a secret so it never leaves the machine's disk through the UI; sending it back keeps the stored value. */
export const MASK = '••••••••';

const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/;
/** Stored in the profile file; never shown or edited in the UI. It does not change when the profile is renamed. */
export const ID_KEY = 'PROFILE_ID';
export const ID = /^[a-z0-9]{8,32}$/;
export const newId = (): string => randomBytes(5).toString('hex');
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const MAX_ENTRIES = 200;
const MAX_VALUE = 4096;

export class ProfileError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface ProfileEntry {
  key: string;
  value: string;
}

export interface ProfileSummary {
  name: string;
  updatedAt: string;
  active: boolean;
}

export const isSecretKey = (key: string): boolean => SECRET_NAME.test(key);

export function validateName(name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name) || /[. ]$/.test(name)) {
    throw new ProfileError('Profile names use letters, digits, spaces, dots, dashes and underscores (up to 60 characters).');
  }
  return name;
}

/** Quotes a value so the .env parser reads back exactly what was typed (a "#" or spaces would otherwise be cut off). */
export function formatValue(value: string): string {
  if (value === '') return '';
  if (!/[\s#'"`\\$]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes('\\')) return `"${value}"`;
  if (!value.includes('`')) return `\`${value}\``;
  throw new ProfileError('A value cannot contain all of the quote characters \' " and `.');
}

export function serialize(entries: ProfileEntry[]): string {
  const lines = ['# d365fo-agent profile. Managed by the web UI; edits made by hand are kept.'];
  for (const e of entries) lines.push(`${e.key}=${formatValue(e.value)}`);
  return `${lines.join('\n')}\n`;
}

export function checkEntries(entries: unknown): ProfileEntry[] {
  if (!Array.isArray(entries)) throw new ProfileError('`entries` must be a list of { key, value }.');
  if (entries.length > MAX_ENTRIES) throw new ProfileError(`At most ${MAX_ENTRIES} variables per profile.`);
  const seen = new Set<string>();
  return entries.map((raw) => {
    const e = raw as Partial<ProfileEntry>;
    const key = typeof e?.key === 'string' ? e.key.trim() : '';
    const value = typeof e?.value === 'string' ? e.value : '';
    if (!KEY.test(key)) throw new ProfileError(`"${key}" is not a valid variable name (letters, digits and underscores).`);
    if (seen.has(key)) throw new ProfileError(`${key} appears twice.`);
    if (/[\r\n]/.test(value)) throw new ProfileError(`${key}: values must be a single line.`);
    if (value.length > MAX_VALUE) throw new ProfileError(`${key}: value is too long.`);
    seen.add(key);
    return { key, value };
  });
}

export class ProfileStore {
  constructor(readonly home: string) {}

  private dir = (): string => profilesDir(this.home);

  /** Path of a profile's .env file (the name is validated, so it cannot point outside the profiles folder). */
  fileFor(name: string): string {
    return join(this.dir(), `${validateName(name)}.env`);
  }

  private async names(): Promise<string[]> {
    try {
      return (await readdir(this.dir())).filter((f) => f.endsWith('.env')).map((f) => f.slice(0, -4)).filter((n) => NAME.test(n)).sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  async list(): Promise<ProfileSummary[]> {
    const active = await this.getActive();
    const out: ProfileSummary[] = [];
    for (const name of await this.names()) {
      const st = await stat(this.fileFor(name));
      out.push({ name, updatedAt: st.mtime.toISOString(), active: name === active });
    }
    return out;
  }

  /** The stored name that matches regardless of letter case (macOS and Windows file systems ignore it). */
  private async find(name: string): Promise<string | undefined> {
    const lower = name.toLowerCase();
    return (await this.names()).find((n) => n.toLowerCase() === lower);
  }

  async exists(name: string): Promise<boolean> {
    return (await this.find(validateName(name))) !== undefined;
  }

  /** Values of a profile, with secrets masked unless `reveal` is set (used only by the agent itself, never the UI). */
  async read(name: string, reveal = false): Promise<ProfileEntry[]> {
    validateName(name);
    const stored = await this.find(name);
    if (!stored) throw new ProfileError(`No profile named "${name}".`, 404);
    const text = await readFile(this.fileFor(stored), 'utf8');
    return this.parseOrdered(text)
      .filter((e) => reveal || e.key !== ID_KEY)
      .map((e) => (!reveal && isSecretKey(e.key) && e.value ? { key: e.key, value: MASK } : e));
  }

  private parseOrdered(text: string): ProfileEntry[] {
    const parsed = dotenv.parse(text);
    const order: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=/.exec(line);
      if (m && !order.includes(m[1]) && m[1] in parsed) order.push(m[1]);
    }
    return order.map((key) => ({ key, value: parsed[key] }));
  }

  /** Creates or replaces a profile. A secret sent back as MASK keeps the value already stored. */
  async write(name: string, entries: unknown, mode: 'create' | 'replace'): Promise<void> {
    validateName(name);
    const checked = checkEntries(entries);
    const existing = await this.find(name);
    if (mode === 'create' && existing) throw new ProfileError(`A profile named "${existing}" already exists.`, 409);
    if (mode === 'replace' && !existing) throw new ProfileError(`No profile named "${name}".`, 404);
    const stored = existing ?? name;
    const old = existing ? new Map((await this.read(stored, true)).map((e) => [e.key, e.value])) : new Map<string, string>();
    const id = old.get(ID_KEY) && ID.test(old.get(ID_KEY)!) ? old.get(ID_KEY)! : newId();
    const final = [
      ...checked.filter((e) => e.key !== ID_KEY),
      { key: ID_KEY, value: id },
    ]
      .map((e) => (e.value === MASK && isSecretKey(e.key) ? { key: e.key, value: old.get(e.key) ?? '' } : e))
      .filter((e) => !(isSecretKey(e.key) && e.value === MASK));
    await mkdir(this.dir(), { recursive: true, mode: 0o700 });
    const target = this.fileFor(stored);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, serialize(final), { mode: 0o600 });
    await rename(tmp, target);
    await chmod(target, 0o600).catch(() => undefined);
  }

  async delete(name: string): Promise<void> {
    const stored = await this.find(validateName(name));
    if (!stored) throw new ProfileError(`No profile named "${name}".`, 404);
    await rm(this.fileFor(stored));
    if ((await this.getActive()) === stored) await this.setActive(undefined);
  }

  async duplicate(from: string, to: string): Promise<void> {
    validateName(to);
    const stored = await this.find(validateName(from));
    if (!stored) throw new ProfileError(`No profile named "${from}".`, 404);
    if (await this.find(to)) throw new ProfileError(`A profile named "${to}" already exists.`, 409);
    const entries = (await this.read(stored, true)).filter((e) => e.key !== ID_KEY);
    await mkdir(this.dir(), { recursive: true, mode: 0o700 });
    await writeFile(this.fileFor(to), serialize([...entries, { key: ID_KEY, value: newId() }]), { mode: 0o600 });
  }

  /** The profile's permanent id, added to older profiles on first use. */
  async idOf(name: string): Promise<string> {
    const stored = await this.find(validateName(name));
    if (!stored) throw new ProfileError(`No profile named "${name}".`, 404);
    const entries = await this.read(stored, true);
    const id = entries.find((e) => e.key === ID_KEY)?.value;
    if (id && ID.test(id)) return id;
    const fresh = newId();
    const target = this.fileFor(stored);
    await writeFile(target, serialize([...entries.filter((e) => e.key !== ID_KEY), { key: ID_KEY, value: fresh }]), { mode: 0o600 });
    return fresh;
  }

  /** Gives a profile a new display name. Its id, and so its report folder, stay the same. */
  async rename(from: string, to: string): Promise<void> {
    validateName(to);
    const stored = await this.find(validateName(from));
    if (!stored) throw new ProfileError(`No profile named "${from}".`, 404);
    const clash = await this.find(to);
    if (clash && clash !== stored) throw new ProfileError(`A profile named "${clash}" already exists.`, 409);
    await this.idOf(stored);
    const wasActive = (await this.getActive()) === stored;
    if (stored !== to) {
      const tmp = `${this.fileFor(stored)}.rename`;
      await rename(this.fileFor(stored), tmp);
      await rename(tmp, this.fileFor(to));
    }
    if (wasActive) await this.setActive(to);
  }

  async getActive(): Promise<string | undefined> {
    try {
      const { active } = JSON.parse(await readFile(stateFile(this.home), 'utf8')) as { active?: unknown };
      return typeof active === 'string' && NAME.test(active) ? ((await this.find(active)) ?? undefined) : undefined;
    } catch {
      return undefined;
    }
  }

  async setActive(name: string | undefined): Promise<void> {
    let stored: string | undefined;
    if (name !== undefined) {
      stored = await this.find(validateName(name));
      if (!stored) throw new ProfileError(`No profile named "${name}".`, 404);
    }
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(await readFile(stateFile(this.home), 'utf8')) as Record<string, unknown>;
    } catch {
      /* no state yet */
    }
    await writeFile(stateFile(this.home), JSON.stringify({ ...state, active: stored ?? null }), { mode: 0o600 });
  }
}
