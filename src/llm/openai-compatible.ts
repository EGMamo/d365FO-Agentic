import type {
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmProvider,
  LlmToolCall,
} from './types.js';
import { fetchWithResilience, parseRetryAfterMs } from '../utils/http.js';
import { LlmHttpError } from './errors.js';

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
  /** Resolves credentials per request (short-lived tokens). Overrides `apiKey` / `baseUrl`. */
  resolveAuth?: () => Promise<{ apiKey: string; baseUrl?: string }>;
  /** Called on HTTP 401 so cached credentials can be dropped; the request is then retried once. */
  onUnauthorized?: () => void;
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

    const send = async (): Promise<Response> => {
      const auth = await this.opts.resolveAuth?.();
      const apiKey = auth?.apiKey ?? this.opts.apiKey;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(this.opts.headers ?? {}),
      };
      if (!apiKey) {
        // Local servers (Ollama, LM Studio, llama.cpp) need no key; do not send an empty bearer token.
      } else if ((this.opts.authScheme ?? 'bearer') === 'bearer') {
        headers.authorization = ['Bearer', apiKey].join(' ');
      } else {
        headers[this.opts.authHeaderName ?? 'api-key'] = apiKey;
      }

      return fetchWithResilience(
        auth?.baseUrl ?? this.opts.baseUrl,
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
    };

    let res = await send();
    if (res.status === 401 && this.opts.onUnauthorized) {
      await res.text().catch(() => '');
      this.opts.onUnauthorized();
      res = await send();
    }

    if (!res.ok) {
      const text = await res.text();
      throw new LlmHttpError(`${this.name} error ${res.status}: ${text}`, res.status, parseRetryAfterMs(res.headers.get('retry-after')));
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

    // Some servers (GitHub Copilot for Claude models) split one reply across choices: the text in the first,
    // the tool call in a later one. Only one completion is ever requested, so merge them all.
    const choices = data.choices ?? [];
    const toolCalls: LlmToolCall[] = choices
      .flatMap((c) => c.message?.tool_calls ?? [])
      .map((c) => ({ id: c.id, name: c.function.name, arguments: safeParseJson(c.function.arguments) }));
    const finishReason = choices.find((c) => c.finish_reason === 'tool_calls')?.finish_reason ?? choices[0]?.finish_reason;

    // Some servers report finish_reason "stop" even when the model called tools; the calls are what matters.
    const stopReason: LlmCompleteResponse['stopReason'] =
      finishReason === 'tool_calls' || toolCalls.length > 0
        ? 'tool_use'
        : finishReason === 'length'
          ? 'max_tokens'
          : finishReason === 'stop'
            ? 'end_turn'
            : 'other';

    return {
      text: choices.map((c) => c.message?.content ?? '').filter(Boolean).join('\n'),
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
