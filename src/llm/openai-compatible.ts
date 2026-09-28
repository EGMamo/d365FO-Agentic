import type {
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmProvider,
  LlmToolCall,
} from './types.js';
import { fetchWithResilience } from '../utils/http.js';

export interface OpenAiCompatibleOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  headers?: Record<string, string>;
  authScheme?: 'bearer' | 'header';
  authHeaderName?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
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
      headers.authorization = ['Bearer', this.opts.apiKey].join(' ');
    } else {
      headers[this.opts.authHeaderName ?? 'api-key'] = this.opts.apiKey;
    }

    const res = await fetchWithResilience(
      this.opts.baseUrl,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
      {
        timeoutMs: this.opts.timeoutMs ?? 60000,
        maxRetries: this.opts.maxRetries ?? 2,
        retryBaseMs: this.opts.retryBaseMs ?? 500,
      },
    );

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
