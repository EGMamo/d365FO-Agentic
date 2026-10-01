import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DotenvProblem {
  line: number;
  key: string;
  message: string;
  /** The variable holds a credential, so a truncated value means signing in with the wrong secret. */
  secret: boolean;
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/;
export const SECRET_NAME = /PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|_KEY$|_PAT$/i;

/**
 * Finds unquoted values whose "#" the .env parser will treat as the start of a comment. A password such as
 * `M654#@!m` is silently read as `M654`. A `#` that follows whitespace is a normal inline comment and is left alone.
 */
export function dotenvProblems(text: string): DotenvProblem[] {
  const problems: DotenvProblem[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = LINE.exec(raw);
    if (!m || raw.trimStart().startsWith('#')) return;
    const [, key, value] = m;
    if (/^["'`]/.test(value.trimStart()) || !/\S#/.test(value)) return;
    const kept = value.split('#')[0].trim().length;
    problems.push({
      line: i + 1,
      key,
      secret: SECRET_NAME.test(key),
      message: `.env line ${i + 1}: ${key} contains an unquoted "#", so everything from it on is cut off as a comment and only ${kept} character(s) are read. Wrap the value in quotes: ${key}='...'`,
    });
  });
  return problems;
}

/** Checks the `.env` in the working directory (where `dotenv/config` loads it from). */
export function dotenvFileProblems(path = resolve('.env')): DotenvProblem[] {
  try {
    return existsSync(path) ? dotenvProblems(readFileSync(path, 'utf8')) : [];
  } catch {
    return [];
  }
}
