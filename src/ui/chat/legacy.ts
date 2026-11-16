import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatConversation, ChatMessage, ChatRepository } from './types.js';

interface LegacyRow {
  id: unknown;
  title: unknown;
  created_at: unknown;
  updated_at: unknown;
  chat: unknown;
}

type LegacyReader = (database: string) => Promise<LegacyRow[]>;

export interface LegacyImportResult {
  imported: number;
  skipped: number;
  unchanged: boolean;
}

/**
 * One-way, non-destructive migration from Open WebUI's SQLite database. Existing user text is preserved;
 * Open WebUI-specific tool traces are intentionally not replayed into the new provider's tool protocol.
 */
export async function importOpenWebUiChats(
  repository: ChatRepository,
  dataDirectory: string,
  stateFile: string,
  read: LegacyReader = readOpenWebUiDatabase,
): Promise<LegacyImportResult> {
  const database = join(dataDirectory, 'webui.db');
  let signature: string;
  try {
    const info = await stat(database);
    signature = `${info.size}:${info.mtimeMs}`;
    // Committed rows can sit only in the WAL, so its growth must also trigger a re-scan.
    const wal = await stat(`${database}-wal`).catch(() => undefined);
    if (wal) signature += `:${wal.size}:${wal.mtimeMs}`;
  } catch {
    return { imported: 0, skipped: 0, unchanged: true };
  }
  try {
    const previous = JSON.parse(await readFile(stateFile, 'utf8')) as { database?: string; signature?: string };
    if (previous.database === database && previous.signature === signature) return { imported: 0, skipped: 0, unchanged: true };
  } catch {
    // First migration, or an interrupted one; stable importedFrom ids make it safe to resume.
  }

  const rows = await read(database);
  const existing = new Set((await repository.list()).map((c) => c.importedFrom).filter(Boolean));
  let imported = 0;
  let skipped = 0;
  for (const row of rows) {
    const legacyId = String(row.id ?? '');
    if (!legacyId) continue;
    const source = `openwebui:${legacyId}`;
    if (existing.has(source)) {
      skipped++;
      continue;
    }
    const chat = convert(row, source);
    if (!chat.messages.length) {
      skipped++;
      continue;
    }
    await repository.import(chat);
    existing.add(source);
    imported++;
  }
  const temporary = `${stateFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, database, signature }, null, 2), { mode: 0o600 });
  await rename(temporary, stateFile);
  return { imported, skipped, unchanged: false };
}

/** Reads just the conversation table with Node's built-in SQLite reader, including committed WAL data. */
async function readOpenWebUiDatabase(path: string): Promise<LegacyRow[]> {
  const { DatabaseSync } = await import('node:sqlite');
  // A read-only connection never changes the legacy database. If SQLite cannot attach its WAL in read-only
  // mode, retry with a normal connection; the only statements executed are SELECTs, and it closes promptly.
  const read = (readOnly: boolean): LegacyRow[] => {
    const db = new DatabaseSync(path, { readOnly });
    try {
      return db.prepare('SELECT id, title, created_at, updated_at, chat FROM chat WHERE archived = 0 OR archived IS NULL ORDER BY updated_at DESC').all() as unknown as LegacyRow[];
    } finally {
      db.close();
    }
  };
  try {
    return read(true);
  } catch {
    return read(false);
  }
}

function convert(row: LegacyRow, importedFrom: string): ChatConversation {
  let payload: { messages?: unknown; history?: { messages?: unknown; currentId?: unknown } } = {};
  try {
    payload = JSON.parse(String(row.chat ?? '{}')) as typeof payload;
  } catch {
    // Keep the title even when Open WebUI's JSON payload is damaged; unreadable messages are skipped.
  }
  const raw = Array.isArray(payload.messages) ? payload.messages : currentBranch(payload.history);
  const at = timestamp(row.updated_at) ?? timestamp(row.created_at) ?? new Date().toISOString();
  const messages: ChatMessage[] = [];
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object') continue;
    const message = candidate as { id?: unknown; role?: unknown; content?: unknown; timestamp?: unknown; created_at?: unknown };
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const content = text(message.content);
    if (!content.trim()) continue;
    messages.push({
      id: uuid(String(message.id ?? randomUUID())), role: message.role, content,
      at: timestamp(message.timestamp ?? message.created_at) ?? at,
    });
  }
  return {
    version: 1,
    id: uuid(`openwebui:${String(row.id)}`),
    title: String(row.title || 'Imported chat').replace(/\s+/g, ' ').trim().slice(0, 100),
    createdAt: timestamp(row.created_at) ?? at,
    updatedAt: at,
    messages,
    importedFrom,
  };
}

function currentBranch(history: { messages?: unknown; currentId?: unknown } | undefined): unknown[] {
  if (!history?.messages || typeof history.messages !== 'object' || Array.isArray(history.messages)) return [];
  const byId = history.messages as Record<string, { parentId?: unknown }>;
  const branch: unknown[] = [];
  let id = typeof history.currentId === 'string' ? history.currentId : undefined;
  while (id && byId[id] && branch.length < 500) {
    branch.unshift(byId[id]);
    const parent = byId[id].parentId;
    id = typeof parent === 'string' ? parent : undefined;
  }
  return branch;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 100_000_000_000 ? value * 1000 : value).toISOString();
  if (typeof value === 'string' && value && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
  return '';
}

/** A deterministic UUID-shaped identity lets a crashed migration resume without duplicating a chat. */
function uuid(value: string): string {
  if (/^[a-f0-9-]{36}$/i.test(value)) return value.toLowerCase();
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const raw = hex.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}
