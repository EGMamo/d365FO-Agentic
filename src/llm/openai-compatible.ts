import { fetch } from 'undici';
import type {
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmProvider,
  LlmToolCall,
} from './types.js';

/**
 * Minimal adapter for OpenAI-compatible Chat Completions endpoints. Works for
 * OpenAI, Azure OpenAI, and GitHub Models with the appropriate base URL and
 * auth header. Kept lightweight — no extra SDK dependency.
 */
export interface OpenAiCompatibleOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  /** Extra headers, e.g. `api-key` for Azure OpenAI. */
  headers?: Record<string, string>;
  /** Bearer scheme vs api-key header. */
  authScheme?: 'bearer' | 'header';
  authHeaderName?: string;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  private opts: OpenAiCompatibleOptions;

  constructor(opts: OpenAiCompatibleOptions) {
    this.name = opts.name;
    this.opts = opts;
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const messages: Array<Record<string, unknown>> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) {
      if (m.role === 'system') messages.push({ role: 'system', content: m.content });
      else if (m.role === 'user') messages.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') {
        const msg: Record<string, unknown> = { role: 'assistant', content: m.content || null };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }));
        }
        messages.push(msg);
      } else if (m.role === 'tool') {
        messages.push({
          role: 'tool',
          tool_call_id: m.toolCallId,
          name: m.toolName,
          content: m.content,
        });
      }
    }

    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages,
      max_tokens: req.maxTokens ?? this.opts.maxTokens,
      temperature: req.temperature ?? this.opts.temperature,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.opts.headers ?? {}),
    };
    if ((this.opts.authScheme ?? 'bearer') === 'bearer') {
      headers.authorization = `Bearer ${this.opts.apiKey}`;
    } else {
      headers[this.opts.authHeaderName ?? 'api-key'] = this.opts.apiKey;
    }

    const res = await fetch(this.opts.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${this.name} error ${res.status}: ${text}`);
    }
    const data = (await res.json()) as {
      choices: Array<{
        message: {
          content?: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    const toolCalls: LlmToolCall[] = (choice?.message.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      arguments: safeParseJson(c.function.arguments),
    }));
    const stopReason: LlmCompleteResponse['stopReason'] =
      choice?.finish_reason === 'tool_calls'
        ? 'tool_use'
        : choice?.finish_reason === 'length'
          ? 'max_tokens'
          : choice?.finish_reason === 'stop'
            ? 'end_turn'
            : 'other';
    return {
      text: choice?.message.content ?? '',
      toolCalls,
      stopReason,
      usage: {
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
      },
    };
  }
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
