import type { LlmMessage, LlmProvider, LlmTool } from '../llm/types.js';

/**
 * Built-in chat for the settings app, so a normal user does not need Open WebUI or Docker. The model of the
 * profile in use gets the same tools Open WebUI gets (built from the OpenAPI document in tools.ts), and each call
 * goes to the bearer-protected /tools routes of this app, so the chat can do nothing the tool server cannot.
 */
export const CHAT_SYSTEM = [
  'You are the D365FO test assistant inside the D365FO Agent settings app.',
  'You help a tester run Dynamics 365 Finance & Operations regression tests: check the setup, pick a profile (environment), write and read local test cases, start runs, follow them, explain results and upload them to Azure DevOps.',
  'Use the tools to act; never invent results. Test-case folders are inside the project, usually "examples/testcases".',
  'Before a run that is not a dry run, and before any upload to Azure DevOps, say what you are about to do and wait for the user to confirm.',
  'After start_run, call get_run with waitSeconds 240 and do what its "next" field says until the run has finished; its results then come with it.',
  'Before delete_test_case, name the file and wait for the user to confirm.',
  'Answer in short plain sentences. Settings and secrets are edited on the Setup tab, never in the chat.',
].join(' ');

const MAX_TOOL_RESULT = 12_000;
const MAX_STEPS = 12;

interface Route {
  method: string;
  path: string;
  query: string[];
  pathParams: string[];
  body: string[];
}

export interface ChatToolSet {
  tools: LlmTool[];
  routes: Map<string, Route>;
}

/** Turns the tool server's OpenAPI document into LLM tools and the routes to call for each. */
export function chatTools(spec: Record<string, unknown>): ChatToolSet {
  const tools: LlmTool[] = [];
  const routes = new Map<string, Route>();
  for (const [path, ops] of Object.entries(spec.paths as Record<string, Record<string, any>>)) {
    for (const [method, op] of Object.entries(ops)) {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const route: Route = { method: method.toUpperCase(), path, query: [], pathParams: [], body: [] };
      for (const p of (op.parameters ?? []) as Array<{ name: string; in: string; required?: boolean; description?: string; schema: Record<string, unknown> }>) {
        properties[p.name] = { ...p.schema, ...(p.description ? { description: p.description } : {}) };
        if (p.required) required.push(p.name);
        (p.in === 'path' ? route.pathParams : route.query).push(p.name);
      }
      const body = op.requestBody?.content?.['application/json']?.schema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
      for (const [k, v] of Object.entries(body?.properties ?? {})) {
        properties[k] = v;
        route.body.push(k);
      }
      required.push(...(body?.required ?? []));
      tools.push({ name: op.operationId, description: op.summary, inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) } });
      routes.set(op.operationId, route);
    }
  }
  return { tools, routes };
}

/** Calls one tool on the tool server at `baseUrl` (ending in /tools) and returns its JSON reply as text. */
export async function callTool(set: ChatToolSet, baseUrl: string, token: string, name: string, args: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<string> {
  const route = set.routes.get(name);
  if (!route) return JSON.stringify({ error: `Unknown tool "${name}".` });
  let path = route.path;
  for (const p of route.pathParams) path = path.replace(`{${p}}`, encodeURIComponent(String(args[p] ?? '')));
  const url = new URL(baseUrl.replace(/\/+$/, '') + path);
  for (const q of route.query) if (args[q] !== undefined && args[q] !== null && args[q] !== '') url.searchParams.set(q, String(args[q]));
  const body: Record<string, unknown> = {};
  for (const b of route.body) if (args[b] !== undefined) body[b] = args[b];
  const hasBody = route.method !== 'GET';
  try {
    const res = await fetchImpl(url, {
      method: route.method,
      headers: { Authorization: `Bearer ${token}`, ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return text.length > MAX_TOOL_RESULT ? `${text.slice(0, MAX_TOOL_RESULT)}… (cut, ${text.length} characters in all)` : text;
  } catch (e) {
    return JSON.stringify({ error: `The tool could not be reached: ${(e as Error).message}` });
  }
}

export interface ChatTurn {
  reply: string;
  /** Tools the model used in this turn, in order. */
  used: string[];
}

/**
 * Answers the last user message: lets the model call tools until it gives a plain answer.
 * `history` holds the earlier user and assistant texts; tool calls of earlier turns are not kept.
 */
export async function chatTurn(
  provider: LlmProvider,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  tools: LlmTool[],
  call: (name: string, args: Record<string, unknown>) => Promise<string>,
  maxSteps = MAX_STEPS,
): Promise<ChatTurn> {
  const messages: LlmMessage[] = history.map((m) => ({ role: m.role, content: m.content }));
  const used: string[] = [];
  for (let step = 0; step < maxSteps; step++) {
    const res = await provider.complete({ system: CHAT_SYSTEM, messages, tools });
    if (!res.toolCalls.length) return { reply: res.text.trim() || '(no answer)', used };
    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
    for (const tc of res.toolCalls) {
      used.push(tc.name);
      messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, content: await call(tc.name, tc.arguments ?? {}) });
    }
  }
  return { reply: 'I stopped after many tool calls without an answer. Ask again, or narrow the question.', used };
}

/** Keeps only well-formed user/assistant text messages from a request body, the last one being the user's. */
export function parseHistory(raw: unknown): Array<{ role: 'user' | 'assistant'; content: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((m): m is { role: 'user' | 'assistant'; content: string } => !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim() !== '')
    .slice(-40)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 20_000) }));
  return out.length && out[out.length - 1].role === 'user' ? out : undefined;
}
