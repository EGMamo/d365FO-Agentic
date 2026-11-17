import { LlmHttpError } from './errors.js';
import type { LlmCompleteRequest, LlmCompleteResponse, LlmProvider, LlmToolCall } from './types.js';
import { fetchWithResilience, parseRetryAfterMs } from '../utils/http.js';

/**
 * The base URL for an OpenAI-compatible gateway, ending in its version segment (`.../v1`), to which
 * `/chat/completions` and `/models` are appended. People paste the address in several forms; all are accepted:
 * `https://gw.example`, `https://gw.example/v1/`, `https://gw.example/v1/chat/completions`.
 */
export function normalizeOpenAiBaseUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  const base = trimmed.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  return /\/v\d+(beta\d*)?$/i.test(base) ? base : `${base}/v1`;
}

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

interface WireResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | Array<{ type?: string; text?: string }> | null; tool_calls?: WireToolCall[] };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string };
}

export interface OpenAiCompatibleOptions {
  /** Sent as `Authorization: Bearer`. */
  apiKey: string;
  /** Gateway address; see normalizeOpenAiBaseUrl. */
  baseURL: string;
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
}

/**
 * Adapter for gateways that serve the OpenAI chat-completions protocol (LiteLLM and most corporate GenAI
 * gateways) in front of Claude or another tool-capable model. Projects function calling onto the shared
 * `LlmProvider` shape, so the runner and Chat do not know which protocol is in use.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai-compatible';
  private readonly endpoint: string;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    const base = normalizeOpenAiBaseUrl(opts.baseURL);
    if (!base) throw new Error('An OpenAI-compatible gateway needs its API URL.');
    this.endpoint = `${base}/chat/completions`;
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    req.signal?.throwIfAborted();
    const tools = (req.tools ?? []).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: functionParameters(t.inputSchema) },
    }));
    const body = {
      model: this.opts.model,
      max_tokens: req.maxTokens ?? this.opts.maxTokens,
      temperature: req.temperature ?? this.opts.temperature,
      messages: toWireMessages(req),
      ...(tools.length ? { tools } : {}),
    };
    const res = await fetchWithResilience(
      this.endpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify(body),
        signal: req.signal,
      },
      { timeoutMs: this.opts.timeoutMs ?? 120_000, maxRetries: this.opts.maxRetries ?? 2, retryBaseMs: this.opts.retryBaseMs ?? 800 },
    );
    const raw = await res.text();
    req.signal?.throwIfAborted();
    let parsed: WireResponse | undefined;
    try {
      parsed = raw ? (JSON.parse(raw) as WireResponse) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const detail = parsed?.error?.message ?? raw.slice(0, 300).trim();
      throw new LlmHttpError(`HTTP ${res.status} from the gateway${detail ? `: ${detail}` : ''}`, res.status, parseRetryAfterMs(res.headers.get('retry-after')));
    }
    const choice = parsed?.choices?.[0];
    if (!choice?.message) throw new Error(`The gateway answered without a message${parsed?.error?.message ? `: ${parsed.error.message}` : '.'}`);
    return fromWireResponse(choice, parsed?.usage);
  }
}

/** Maps the shared conversation onto chat-completions messages. Tool results become `tool` messages. */
export function toWireMessages(req: Pick<LlmCompleteRequest, 'system' | 'messages'>): WireMessage[] {
  const out: WireMessage[] = req.system ? [{ role: 'system', content: req.system }] : [];
  for (const m of req.messages) {
    if (m.role === 'system') continue; // the request's `system` is authoritative, as in the Anthropic adapter
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content });
    } else if (m.role === 'assistant') {
      const calls = (m.toolCalls ?? []).map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } }));
      out.push({ role: 'assistant', content: m.content || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }
  return out;
}

function fromWireResponse(choice: NonNullable<WireResponse['choices']>[number], usage: WireResponse['usage']): LlmCompleteResponse {
  const message = choice.message ?? {};
  const text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content) ? message.content.map((p) => (p?.type === 'text' || p?.text ? p.text ?? '' : '')).join('') : '';
  const toolCalls: LlmToolCall[] = (message.tool_calls ?? [])
    .filter((c) => c?.function?.name)
    .map((c, i) => ({ id: c.id || `call_${i}`, name: c.function!.name!, arguments: parseArguments(c.function!.arguments) }));
  const finish = choice.finish_reason ?? '';
  const stopReason: LlmCompleteResponse['stopReason'] = toolCalls.length || finish === 'tool_calls' || finish === 'function_call'
    ? 'tool_use'
    : finish === 'stop' || finish === 'end_turn' ? 'end_turn' : finish === 'length' || finish === 'max_tokens' ? 'max_tokens' : 'other';
  return {
    text,
    toolCalls,
    stopReason,
    usage: {
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
      cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens,
    },
  };
}

/** Function arguments arrive as a JSON string; a model that sends invalid JSON gets an empty object, as no arguments. */
function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Function parameters must be an object schema; `$schema` markers from MCP tool schemas are rejected by some backends. */
function functionParameters(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema ?? {};
  return rest.type ? rest : { type: 'object', properties: {}, ...rest };
}
