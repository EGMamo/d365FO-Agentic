import type { TestStep } from '../testing/types.js';
import { decodeEntities } from './entities.js';

/** A deliberately small, tolerant XML reader for Azure DevOps' test-case fields (not a general-purpose XML parser). */
export interface XmlNode { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string }

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].name.toLowerCase() === m[2].toLowerCase()) { stack.length = i; break; }
    } else if (m[3]) {
      const attrs: Record<string, string> = {};
      const ar = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = ar.exec(m[4]))) attrs[a[1]] = decodeEntities(a[3] ?? a[4] ?? '');
      const node: XmlNode = { name: m[3], attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += m[6];
  }
  return root;
}

const local = (name: string): string => name.replace(/^.*:/, '');
export const child = (node: XmlNode, name: string): XmlNode | undefined => node.children.find((c) => local(c.name).toLowerCase() === name.toLowerCase());
export const childrenNamed = (node: XmlNode, name: string): XmlNode[] => node.children.filter((c) => local(c.name).toLowerCase() === name.toLowerCase());
const deepText = (node: XmlNode): string => node.text + node.children.map(deepText).join('');

const stripTags = (value: string): string => {
  let previous = value;
  for (;;) {
    const next = previous.replace(/<[^>]*>/g, '');
    if (next === previous) return previous;
    previous = next;
  }
};

/** ADO's formatted strings contain escaped HTML; plain strings must keep angle brackets typed by the case author. */
function stepText(attrs: Record<string, string>, raw: string): string {
  const formatted = /^true$/i.test(attrs.isformatted ?? '');
  const xml = decodeEntities(raw);
  const text = formatted
    ? decodeEntities(stripTags(xml.replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '• ')))
    : xml;
  return text.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export type StepToken =
  | { kind: 'step'; id: number; action: string; expected?: string }
  | { kind: 'shared'; id: number; ref: number; after: StepToken[] };

export function parseStepsXml(xml: string | undefined): StepToken[] {
  if (!xml?.trim()) return [];
  const steps = child(parseXml(xml), 'steps');
  if (!steps) return [];
  const walk = (node: XmlNode): StepToken[] => {
    const out: StepToken[] = [];
    for (const c of node.children) {
      const name = local(c.name).toLowerCase();
      if (name === 'step') {
        const ps = childrenNamed(c, 'parameterizedString');
        const text = (n: XmlNode | undefined): string => n ? stepText(n.attrs, deepText(n)) : '';
        out.push({ kind: 'step', id: Number(c.attrs.id), action: text(ps[0]), ...(ps[1] ? { expected: text(ps[1]) } : {}) });
      } else if (name === 'compref') {
        // ADO nests the steps following a shared-step reference inside compref, rather than beside it.
        out.push({ kind: 'shared', id: Number(c.attrs.id), ref: Number(c.attrs.ref), after: walk(c) });
      }
    }
    return out;
  };
  return walk(steps);
}

const hex8 = (n: number): string => Number.isFinite(n) ? n.toString(16).padStart(8, '0') : '00000000';
export const unreadableSharedSteps = (id: number): string => `Shared steps ${id} could not be loaded from Azure DevOps; check that the work item exists and that your Azure DevOps credentials can read it.`;

export interface FlattenedSteps { steps: TestStep[]; problems: string[] }

/**
 * Expands nested shared steps, preserving ADO action paths. Cycles and unreadable dependencies become explicit
 * placeholders and problems; callers must block such a case instead of silently executing a different test.
 */
export async function flattenSteps(
  tokens: StepToken[],
  getSharedSteps: (id: number) => Promise<StepToken[] | undefined>,
): Promise<FlattenedSteps> {
  const out: TestStep[] = [];
  const problems = new Set<string>();
  const visit = async (list: StepToken[], prefix: string, chain: number[], sharedId?: number): Promise<void> => {
    if (chain.length > 32) {
      problems.add('Shared steps nesting exceeds 32 levels; the test case was not run.');
      return;
    }
    for (const token of list) {
      if (token.kind === 'step') {
        out.push({ index: out.length + 1, adoId: token.id, action: token.action, ...(token.expected !== undefined ? { expected: token.expected } : {}), ...(sharedId ? { sharedStepId: sharedId } : {}), actionPath: prefix + hex8(token.id) });
        continue;
      }
      const path = prefix + hex8(token.id);
      if (chain.includes(token.ref)) {
        const problem = `Shared steps ${token.ref} contain a recursion cycle (${[...chain, token.ref].join(' → ')}); the test case was not run.`;
        problems.add(problem);
        out.push({ index: out.length + 1, adoId: token.id, action: `[${problem}]`, sharedStepId: token.ref, actionPath: path });
      } else {
        const shared = await getSharedSteps(token.ref);
        if (!shared) {
          const problem = unreadableSharedSteps(token.ref);
          problems.add(problem);
          out.push({ index: out.length + 1, adoId: token.id, action: `[${problem}]`, sharedStepId: token.ref, actionPath: path });
        } else {
          await visit(shared, path, [...chain, token.ref], token.ref);
        }
      }
      // Following steps belong to the containing work item, not to the shared item just expanded.
      await visit(token.after, prefix, chain, sharedId);
    }
  };
  await visit(tokens, '', []);
  return { steps: out, problems: [...problems] };
}
