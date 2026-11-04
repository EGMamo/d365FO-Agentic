import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TestCase } from './types.js';

/**
 * Create, edit and delete local test-case files for the web UI. Every path is resolved inside `root` (the project
 * folder) so the browser cannot read or write files elsewhere on the machine.
 */
export class TestCaseFileError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const FILE = /^[\w.-]{1,80}\.json$/i;
const MAX_STEPS = 200;
const MAX_TEXT = 4000;

export interface TestCaseFileSummary {
  file: string;
  id: string;
  title: string;
  steps: number;
  module?: string;
  legalEntity?: string;
  tags: string[];
  error?: string;
}

/** The editable shape saved to disk (no `source`, step indexes renumbered). */
export type TestCaseDraft = Omit<TestCase, 'source'>;

export function resolveCaseDir(root: string, dir: string): string {
  const abs = resolve(root, dir || '.');
  const rel = relative(resolve(root), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new TestCaseFileError('The test-case folder must be inside the project folder.');
  return abs;
}

function checkFile(file: string): string {
  if (!FILE.test(file) || file.startsWith('.')) throw new TestCaseFileError('File names use letters, digits, dots, dashes and underscores and end in .json.');
  return file;
}

/** A file name derived from the case id or title, e.g. "TC-VENDOR-001" -> "tc-vendor-001.json". */
export function fileNameFor(idOrTitle: string): string {
  const slug = idOrTitle
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 70);
  return `${slug || 'test-case'}.json`;
}

const text = (v: unknown, field: string, required = false): string | undefined => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new TestCaseFileError(`${field} is required.`);
    return undefined;
  }
  if (typeof v !== 'string') throw new TestCaseFileError(`${field} must be text.`);
  if (v.length > MAX_TEXT) throw new TestCaseFileError(`${field} is too long.`);
  return v.trim() || undefined;
};

/** Validates a draft sent by the browser and normalises it to what `loadLocalTestCases` reads. */
export function validateDraft(raw: unknown): TestCaseDraft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TestCaseFileError('Send the test case as an object.');
  const r = raw as Record<string, unknown>;
  const title = text(r.title, 'Title', true)!;
  const id = text(r.id, 'Id') ?? fileNameFor(title).replace(/\.json$/, '').toUpperCase();
  if (!/^[\w.-]{1,64}$/.test(id)) throw new TestCaseFileError('Id uses letters, digits, dots, dashes and underscores (up to 64).');
  if (!Array.isArray(r.steps) || r.steps.length === 0) throw new TestCaseFileError('Add at least one step.');
  if (r.steps.length > MAX_STEPS) throw new TestCaseFileError(`At most ${MAX_STEPS} steps.`);
  const steps = r.steps.map((s, i) => {
    const step = (s ?? {}) as Record<string, unknown>;
    const action = text(step.action, `Step ${i + 1} action`, true)!;
    const expected = text(step.expected, `Step ${i + 1} expected result`);
    return { index: i + 1, action, ...(expected ? { expected } : {}) };
  });
  const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim()).slice(0, 20) : [];
  const priority = r.priority === undefined || r.priority === '' || r.priority === null ? undefined : Number(r.priority);
  if (priority !== undefined && (!Number.isInteger(priority) || priority < 1 || priority > 4)) throw new TestCaseFileError('Priority is 1-4.');
  const draft: TestCaseDraft = { id, title, steps, tags };
  const opt: Array<[keyof TestCaseDraft, string]> = [
    ['module', 'Module'],
    ['area', 'Area'],
    ['legalEntity', 'Legal entity'],
    ['preconditions', 'Preconditions'],
  ];
  for (const [k, label] of opt) {
    const v = text(r[k], label);
    if (v) (draft as unknown as Record<string, unknown>)[k] = v;
  }
  if (priority !== undefined) draft.priority = priority;
  return draft;
}

export class TestCaseFiles {
  constructor(private readonly root: string) {}

  /** Resolve each component without following links imported with a case repository. */
  private async directory(dir: string, create = false): Promise<string> {
    const lexical = resolveCaseDir(this.root, dir);
    if (create) await mkdir(this.root, { recursive: true });
    const root = await realpath(this.root);
    let current = root;
    for (const part of relative(resolve(this.root), lexical).split(sep).filter(Boolean)) {
      const next = join(current, part);
      if (create) {
        try { await mkdir(next); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      }
      const info = await lstat(next);
      if (info.isSymbolicLink()) throw new TestCaseFileError('Symbolic links are not allowed in test-case paths.');
      if (!info.isDirectory()) throw new TestCaseFileError('The test-case folder must be a directory.');
      const canonical = await realpath(next);
      const rel = relative(root, canonical);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TestCaseFileError('The test-case folder must be inside the project folder.');
      current = canonical;
    }
    return current;
  }

  private async file(dir: string, file: string, allowMissing = false): Promise<string> {
    const target = join(await this.directory(dir), checkFile(file));
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new TestCaseFileError('Symbolic links are not allowed in test-case paths.');
      if (!info.isFile()) throw new TestCaseFileError('The test case must be a regular file.');
    } catch (e) {
      if (!allowMissing || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return target;
  }

  private async readFile(dir: string, file: string): Promise<string> {
    const handle = await open(await this.file(dir, file), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { return await handle.readFile('utf8'); } finally { await handle.close(); }
  }

  async list(dir: string): Promise<TestCaseFileSummary[]> {
    resolveCaseDir(this.root, dir);
    let names: string[];
    try {
      names = (await readdir(await this.directory(dir), { withFileTypes: true })).filter((e) => e.isFile() && FILE.test(e.name)).map((e) => e.name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: TestCaseFileSummary[] = [];
    for (const file of names.sort()) {
      try {
        const p = JSON.parse(await this.readFile(dir, file)) as Partial<TestCase>;
        out.push({
          file,
          id: p.id ?? file.replace(/\.json$/i, ''),
          title: p.title ?? '(no title)',
          steps: Array.isArray(p.steps) ? p.steps.length : 0,
          module: p.module,
          legalEntity: p.legalEntity,
          tags: p.tags ?? [],
          ...(!p.title || !Array.isArray(p.steps) ? { error: 'Not a test case: needs a title and steps; runs skip it.' } : {}),
        });
      } catch (e) {
        if (e instanceof TestCaseFileError) throw e;
        out.push({ file, id: file.replace(/\.json$/i, ''), title: '(unreadable)', steps: 0, tags: [], error: 'The file is not valid JSON; runs skip it.' });
      }
    }
    return out;
  }

  async read(dir: string, file: string): Promise<TestCaseDraft> {
    resolveCaseDir(this.root, dir);
    checkFile(file);
    try {
      const p = JSON.parse(await this.readFile(dir, file)) as TestCase;
      return { ...p, id: p.id ?? file.replace(/\.json$/i, ''), steps: p.steps ?? [], tags: p.tags ?? [] };
    } catch (e) {
      if (e instanceof TestCaseFileError) throw e;
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new TestCaseFileError('Test case not found.', 404);
      throw new TestCaseFileError('The file is not valid JSON.');
    }
  }

  /**
   * Saves a draft. `file` is the existing file being edited; without it a new file is created from the id and an
   * existing file of that name is not overwritten.
   */
  async save(dir: string, draft: unknown, file?: string): Promise<{ file: string; testCase: TestCaseDraft }> {
    resolveCaseDir(this.root, dir);
    const tc = validateDraft(draft);
    const existing = await this.list(dir);
    const clash = existing.find((c) => c.id === tc.id && c.file !== file);
    if (clash) throw new TestCaseFileError(`Another test case (${clash.file}) already uses the id ${tc.id}.`, 409);
    const target = file ? checkFile(file) : fileNameFor(tc.id);
    if (!file && existing.some((c) => c.file === target)) throw new TestCaseFileError(`${target} already exists.`, 409);
    await this.directory(dir, true);
    const path = await this.file(dir, target, true);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (file ? 0 : constants.O_EXCL), 0o600);
    try {
      await handle.truncate(0);
      await handle.writeFile(`${JSON.stringify(tc, null, 2)}\n`);
    } finally { await handle.close(); }
    return { file: target, testCase: tc };
  }

  async delete(dir: string, file: string): Promise<void> {
    try {
      await unlink(await this.file(dir, file));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new TestCaseFileError('Test case not found.', 404);
      throw e;
    }
  }
}
