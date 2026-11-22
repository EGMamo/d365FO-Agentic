import { decodeEntities } from './entities.js';

/**
 * Azure DevOps test-case parameters. Steps refer to a value as `@Name`; the values live in the test case's
 * "Parameter values" table (`Microsoft.VSTS.TCM.LocalDataSource`) or in shared parameter sets linked to it. Each
 * row of the table is one iteration. The agent runs the first row, so the steps it reads already carry the values.
 *
 * Both fields use the same format: `Parameters` lists the names (`<parameters><param name="Vendor" bind="default"/></parameters>`),
 * `LocalDataSource` is an ADO.NET data set with one `<Table1>` element per row and one child element per name.
 */
export interface ParameterData {
  names: string[];
  rows: Array<Record<string, string>>;
}

export const PARAMETERS_FIELD = 'Microsoft.VSTS.TCM.Parameters';
export const DATASOURCE_FIELD = 'Microsoft.VSTS.TCM.LocalDataSource';

export function parseParameterNames(xml: string | undefined): string[] {
  const names: string[] = [];
  for (const m of (xml ?? '').matchAll(/<param\b[^>]*?\bname\s*=\s*"([^"]+)"/gi)) names.push(decodeEntities(m[1]));
  return names;
}

/** Data set element names escape characters as `_x0020_`. */
const unescapeName = (n: string): string => n.replace(/_x([0-9a-f]{4})_/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

export function parseDataSource(xml: string | undefined): Array<Record<string, string>> {
  if (!xml) return [];
  // Shared parameter sets store rows as key/value pairs rather than as an ADO.NET Table1 data set.
  if (/<parameterSet\b/i.test(xml)) {
    const rows: Array<Record<string, string>> = [];
    for (const row of xml.matchAll(/<dataRow\b[^>]*>([\s\S]*?)<\/dataRow>/gi)) {
      const record: Record<string, string> = {};
      for (const kvp of row[1].matchAll(/<kvp\b([^>]*)\/?\s*>/gi)) {
        const attrs = kvp[1];
        const value = (name: string): string | undefined => {
          const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
          return match ? decodeEntities(match[1] ?? match[2] ?? '') : undefined;
        };
        const key = value('key');
        if (key) record[key] = value('value') ?? '';
      }
      rows.push(record);
    }
    return rows;
  }
  const body = xml.replace(/<(?:xs|xsd):schema[\s\S]*?<\/(?:xs|xsd):schema>/gi, '');
  const rows: Array<Record<string, string>> = [];
  for (const row of body.matchAll(/<(Table\d*)>([\s\S]*?)<\/\1>/g)) {
    const record: Record<string, string> = {};
    for (const f of row[2].matchAll(/<([A-Za-z_][\w.-]*)\s*\/>|<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\2>/g)) {
      record[unescapeName(f[1] ?? f[2])] = f[1] ? '' : decodeEntities(f[3]).trim();
    }
    rows.push(record);
  }
  return rows;
}

export function parseParameterData(fields: Record<string, unknown>): ParameterData {
  const text = (k: string): string | undefined => (typeof fields[k] === 'string' ? (fields[k] as string) : undefined);
  // A shared parameter work item keeps both names and rows in Parameters; a test case keeps rows in LocalDataSource.
  const parameterText = text(PARAMETERS_FIELD);
  const rows = /<parameterSet\b/i.test(parameterText ?? '') ? parseDataSource(parameterText) : parseDataSource(text(DATASOURCE_FIELD));
  const names = [...new Set([...parseParameterNames(parameterText), ...rows.flatMap((r) => Object.keys(r))])];
  return { names, rows };
}

export interface SharedParameterMapping {
  ids: number[];
  map: Array<{ localParamName: string; sharedParameterName: string; sharedParameterDataSetId: number }>;
}

/** Newer ADO work items use JSON in LocalDataSource to map local parameter names to shared sets. */
export function sharedParameterMapping(fields: Record<string, unknown>): SharedParameterMapping {
  const value = fields[DATASOURCE_FIELD];
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return { ids: [], map: [] };
  try {
    const json = JSON.parse(value) as { parameterMap?: SharedParameterMapping['map']; sharedParameterDataSetIds?: number[] };
    return { ids: Array.isArray(json.sharedParameterDataSetIds) ? json.sharedParameterDataSetIds.filter(Number.isInteger) : [], map: Array.isArray(json.parameterMap) ? json.parameterMap : [] };
  } catch {
    return { ids: [], map: [] };
  }
}

/** Renames a shared set's columns to the local @Names used by one test case. */
export function mapSharedParameterData(data: ParameterData, mapping: SharedParameterMapping, id: number): ParameterData {
  const relevant = mapping.map.filter((m) => Number(m.sharedParameterDataSetId) === id);
  if (!relevant.length) return data;
  return {
    names: relevant.map((m) => m.localParamName),
    rows: data.rows.map((row) => Object.fromEntries(relevant.flatMap((m) => m.sharedParameterName in row ? [[m.localParamName, row[m.sharedParameterName]]] : []))),
  };
}

/**
 * The values of one data row. When a name appears in several sets (the case's own table and shared sets), the first
 * non-empty value wins, in the order the sets are given.
 */
export function valuesForRow(sources: ParameterData[], row = 0): Record<string, string> {
  const values: Record<string, string> = {};
  for (const s of sources) {
    for (const [k, v] of Object.entries(s.rows[row] ?? s.rows[0] ?? {})) if (v.trim() && !(k in values)) values[k] = v;
  }
  return values;
}

export function rowCount(sources: ParameterData[]): number {
  return Math.max(0, ...sources.map((s) => s.rows.length));
}

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** The inverse of `unescapeName`: characters an XML element name cannot hold become `_x0020_`. */
const elementName = (n: string): string => n.replace(/[^A-Za-z0-9_.-]/g, (c) => `_x${c.charCodeAt(0).toString(16).padStart(4, '0')}_`);

export function renderParameters(names: string[]): string {
  return `<parameters>${names.map((n) => `<param name="${xmlEscape(n)}" bind="default" />`).join('')}</parameters>`;
}

/** The data set Azure DevOps keeps the "Parameter values" table in: a schema, then one `<Table1>` per row. */
export function renderDataSource(names: string[], rows: Array<Record<string, string>>): string {
  const columns = names.map((n) => `<xs:element name="${elementName(n)}" type="xs:string" minOccurs="0" />`).join('');
  const schema =
    '<xs:schema id="NewDataSet" xmlns="" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:msdata="urn:schemas-microsoft-com:xml-msdata">'
    + '<xs:element name="NewDataSet" msdata:IsDataSet="true" msdata:Locale=""><xs:complexType><xs:choice minOccurs="0" maxOccurs="unbounded">'
    + `<xs:element name="Table1"><xs:complexType><xs:sequence>${columns}</xs:sequence></xs:complexType></xs:element>`
    + '</xs:choice></xs:complexType></xs:element></xs:schema>';
  const body = rows
    .map((r) => `<Table1>${names.map((n) => (r[n] ? `<${elementName(n)}>${xmlEscape(r[n])}</${elementName(n)}>` : '')).join('')}</Table1>`)
    .join('');
  return `<NewDataSet>${schema}${body}</NewDataSet>`;
}

/**
 * Adds values to the first data row of a case's own parameter table. A name that already has a value is never
 * changed (`skipped`): the table may hold what a person chose. Other rows and columns are kept as they are.
 */
export function mergeParameterValues(existing: ParameterData, add: Record<string, string>): { data: ParameterData; saved: string[]; skipped: string[] } {
  const rows = existing.rows.length ? existing.rows.map((r) => ({ ...r })) : [{}];
  const names = [...existing.names];
  const saved: string[] = [];
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(add)) {
    if (!value.trim()) continue;
    if (rows[0][name]?.trim()) {
      skipped.push(name);
      continue;
    }
    rows[0][name] = value.trim();
    if (!names.includes(name)) names.push(name);
    saved.push(name);
  }
  return { data: { names, rows }, saved, skipped };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `@Name`, not the middle of an e-mail address or a word. */
const TOKEN = /(?<![\w@.])@[A-Za-z_]\w*/g;

export function parameterTokens(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[0].slice(1)))];
}

/** Replaces `@Name` with its value, case-insensitively. A name without a value is left as written. */
export function applyParameters(text: string, values: Record<string, string>): string {
  const names = Object.keys(values).sort((a, b) => b.length - a.length);
  if (!names.length || !text) return text;
  const byLower = new Map(names.map((n) => [n.toLowerCase(), values[n]]));
  const re = new RegExp(`(?<![\\w@.])@(${names.map(escapeRe).join('|')})(?!\\w)`, 'gi');
  return text.replace(re, (whole, name: string) => byLower.get(name.toLowerCase()) ?? whole);
}

/** What was filled in and what was not, for the report and the agent. */
export interface ParameterSummary {
  /** 1-based row used, and how many rows there are. */
  row: number;
  rows: number;
  filled: string[];
  /** Names the steps use that have no value. */
  unresolved: string[];
}

export function applyToSteps<T extends { action: string; expected?: string }>(steps: T[], sources: ParameterData[], row = 0): { steps: T[]; summary: ParameterSummary | undefined } {
  const selected = Math.max(0, Math.min(Math.trunc(row), Math.max(0, rowCount(sources) - 1)));
  const all = new Set(steps.flatMap((s) => [...parameterTokens(s.action), ...parameterTokens(s.expected ?? '')]));
  const rows = rowCount(sources);
  if (!all.size) return { steps, summary: rows ? { row: selected + 1, rows, filled: [], unresolved: [] } : undefined };
  const values = valuesForRow(sources, selected);
  const applied = steps.map((s) => ({ ...s, action: applyParameters(s.action, values), ...(s.expected === undefined ? {} : { expected: applyParameters(s.expected, values) }) }));
  const left = new Set(applied.flatMap((s) => [...parameterTokens(s.action), ...parameterTokens(s.expected ?? '')]).map((n) => n.toLowerCase()));
  const unresolved = [...all].filter((n) => left.has(n.toLowerCase()));
  return { steps: applied, summary: { row: selected + 1, rows, filled: [...all].filter((n) => !left.has(n.toLowerCase())), unresolved } };
}
