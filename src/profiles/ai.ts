import { chmod, copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';
import {
  checkEntries,
  ID,
  isSecretKey,
  MASK,
  ProfileError,
  ProfileStore,
  serialize,
  type ProfileEntry,
} from './store.js';

export const DEFAULT_MODEL = 'claude-opus-4-5-20251101';
export const AI_KEYS = [
  'LLM_PROVIDER',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'LLM_MODEL',
  'LLM_MAX_TOKENS',
] as const;
export const aiFile = (home: string): string => join(home, 'ai.env');

/** One connection shared by app-owned Chat and every test run. Legacy files are never deleted. */
export class AiSettings {
  constructor(readonly home: string) {}

  async read(reveal = false): Promise<ProfileEntry[]> {
    if (!existsSync(aiFile(this.home))) return [];
    const data = dotenv.parse(await readFile(aiFile(this.home), 'utf8'));
    return Object.entries(data).map(([key, value]) => ({
      key,
      value: !reveal && isSecretKey(key) && value ? MASK : value,
    }));
  }

  async write(entries: unknown): Promise<void> {
    const checked = checkEntries(entries);
    if (checked.some((e) => !(AI_KEYS as readonly string[]).includes(e.key)))
      throw new ProfileError('Only Claude connection settings belong here.');
    if (checked.some((e) => e.key === 'LLM_PROVIDER' && e.value && e.value !== 'anthropic'))
      throw new ProfileError('This release uses Claude. Your previous connections remain in the settings backup.');
    const old = new Map((await this.read(true)).map((e) => [e.key, e.value]));
    const final = checked
      .filter((e) => e.key !== 'LLM_PROVIDER' && !(['LLM_MODEL', 'LLM_MAX_TOKENS'].includes(e.key) && !e.value.trim()))
      .map((e) => ({ ...e, value: e.value === MASK && isSecretKey(e.key) ? (old.get(e.key) ?? '') : e.value }));
    const url = final.find((e) => e.key === 'ANTHROPIC_BASE_URL')?.value;
    if (url) {
      try {
        if (new URL(url).protocol !== 'https:') throw new Error();
      } catch {
        throw new ProfileError('The Claude API URL must be an HTTPS address.');
      }
    }
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const target = aiFile(this.home);
    await writeFile(`${target}.tmp`, serialize([{ key: 'LLM_PROVIDER', value: 'anthropic' }, ...final]), {
      mode: 0o600,
    });
    await rename(`${target}.tmp`, target);
    await chmod(target, 0o600);
  }

  /** Back up configuration once, then prefer the explicitly selected chat model, else the active profile. */
  async migrate(profiles: ProfileStore): Promise<void> {
    const marker = join(this.home, 'settings-v1.json');
    if (existsSync(marker)) return;
    const backup = join(this.home, 'backups', 'before-simplification-v1');
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const dir of ['', 'profiles', 'models']) {
      const source = join(this.home, dir);
      const destination = join(backup, dir);
      await mkdir(destination, { recursive: true, mode: 0o700 });
      for (const name of await readdir(source).catch(() => [] as string[])) {
        if (!dir && name === 'ai.env') continue;
        if (!(name.endsWith('.env') || (!dir && name === 'state.json'))) continue;
        const target = join(destination, name);
        if (!existsSync(target)) await copyFile(join(source, name), target);
        await chmod(target, 0o600);
      }
    }
    const model = async (id: string | undefined): Promise<ProfileEntry[]> => {
      if (!id || !ID.test(id)) return [];
      try {
        return Object.entries(dotenv.parse(await readFile(join(this.home, 'models', `${id}.env`), 'utf8'))).map(
          ([key, value]) => ({ key, value }),
        );
      } catch {
        return [];
      }
    };
    let state: { chatModel?: string } = {};
    try {
      state = JSON.parse(await readFile(join(this.home, 'state.json'), 'utf8'));
    } catch {
      /* fresh install */
    }
    const active = await profiles.getActive();
    const profile = active ? await profiles.read(active, true) : [];
    const candidates = [
      await model(state.chatModel),
      await model(profile.find((e) => e.key === 'AI_MODEL')?.value),
      profile,
    ];
    if (!existsSync(aiFile(this.home))) {
      const chosen = candidates.find(
        (entries) =>
          (!entries.find((e) => e.key === 'LLM_PROVIDER')?.value ||
            entries.find((e) => e.key === 'LLM_PROVIDER')?.value === 'anthropic') &&
          entries.some((e) => ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].includes(e.key) && e.value),
      );
      if (chosen) await this.write(chosen.filter((e) => (AI_KEYS as readonly string[]).includes(e.key)));
    }
    await writeFile(marker, JSON.stringify({ version: 1, backup, at: new Date().toISOString() }), { mode: 0o600 });
  }
}
