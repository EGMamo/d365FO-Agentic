import { parse } from 'dotenv';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=/;
const BARE = /^[\w@%+=:,./~^!?*$&()[\]{}<>|;-]*$/;

/**
 * Formats a value so that dotenv reads back exactly the same string. Plain values stay bare; anything with a `#`,
 * whitespace, quotes or a backslash is quoted (single quotes are literal in dotenv, so they are preferred).
 */
export function quoteEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Values cannot contain line breaks');
  if (BARE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  // Double quotes expand \n, so only use them when the value has no backslash.
  if (!value.includes('"') && !value.includes('\\')) return `"${value}"`;
  if (!value.includes('`')) return `\`${value}\``;
  throw new Error('Value contains all of \' " ` and cannot be written to .env safely');
}

/**
 * Applies updates to `.env` text in place: existing keys keep their position and surrounding comments, new keys are
 * appended. `null` clears the value (writes `KEY=`).
 */
export function updateEnvText(text: string, updates: Record<string, string | null>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trimStart().startsWith('#')) continue;
    const m = LINE.exec(raw);
    if (!m || !Object.hasOwn(updates, m[1])) continue;
    seen.add(m[1]);
    lines[i] = `${m[1]}=${quoteEnvValue(updates[m[1]] ?? '')}`;
  }
  const added = Object.keys(updates).filter((k) => !seen.has(k));
  if (added.length) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const key of added) lines.push(`${key}=${quoteEnvValue(updates[key] ?? '')}`);
    lines.push('');
  }
  return lines.join(eol);
}

export function parseEnvText(text: string): Record<string, string> {
  return parse(text);
}
