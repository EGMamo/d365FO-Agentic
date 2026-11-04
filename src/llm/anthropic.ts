import Anthropic from '@anthropic-ai/sdk';
import type {
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmProvider,
  LlmToolCall,
} from './types.js';
import { ANTHROPIC_DEFAULT_BASE_URL, normalizeAnthropicBaseUrl } from './endpoint.js';

const EPHEMERAL = { cache_control: { type: 'ephemeral' } } as const;

/** The slice of the SDK client this adapter uses; tests inject a fake. */
export interface AnthropicClientLike {
  messages: { create(params: never, options?: { signal?: AbortSignal }): Promise<Anthropic.Message> };
}

/**
 * Options for the SDK client. Everything is passed explicitly (null when unset), so the client uses
 * exactly what the configuration says and never the SDK's own reading of ANTHROPIC_* variables.
 */
export function anthropicClientOptions(opts: { apiKey?: string; authToken?: string; baseURL?: string }): { apiKey: string | null; authToken: string | null; baseURL: string } {
  return {
    apiKey: opts.apiKey || null,
    authToken: opts.authToken || null,
    baseURL: normalizeAnthropicBaseUrl(opts.baseURL) ?? ANTHROPIC_DEFAULT_BASE_URL,
  };
}

/**
 * Anthropic Claude adapter. Uses the official SDK's tool-use protocol and
 * projects it onto the shared `LlmProvider` shape.
 *
 * With `promptCache` on, two cache breakpoints are set: the system prompt (which
 * also covers the tool schemas that precede it) and the last message block, so
 * each turn re-reads the previous turn's prefix at the cached-token rate instead
 * of paying full price for the whole history. Prompts under the model's minimum
 * cacheable size are simply not cached.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private client: AnthropicClientLike;
  private model: string;
  private defaultMaxTokens: number;
  private defaultTemperature: number;
  private promptCache: boolean;

  constructor(opts: {
    /** Anthropic API key (`x-api-key`). Optional when `authToken` is given. */
    apiKey?: string;
    /** Bearer token for a gateway that takes one in place of an API key. */
    authToken?: string;
    /** Claude-compatible endpoint to call instead of api.anthropic.com. */
    baseURL?: string;
    model: string;
    maxTokens: number;
    temperature: number;
    promptCache?: boolean;
    client?: AnthropicClientLike;
  }) {
    this.client = opts.client ?? (new Anthropic(anthropicClientOptions(opts)) as unknown as AnthropicClientLike);
    this.model = opts.model;
    this.defaultMaxTokens = opts.maxTokens;
    this.defaultTemperature = opts.temperature;
    this.promptCache = opts.promptCache ?? true;
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    req.signal?.throwIfAborted();
    const anthropicMessages: Anthropic.MessageParam[] = [];
    for (const m of req.messages) {
      if (m.role === 'system') continue; // handled via top-level `system`
      if (m.role === 'user') {
        anthropicMessages.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        const blocks: Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: unknown }
        > = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
        }
        anthropicMessages.push({ role: 'assistant', content: blocks });
      } else if (m.role === 'tool') {
        anthropicMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.toolCallId ?? '',
              content: m.content,
            },
          ],
        });
      }
    }

    if (this.promptCache) markLastBlock(anthropicMessages);

    // cache_control is accepted by the API but missing from this SDK version's non-beta request types.
    const params = {
      model: this.model,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      temperature: req.temperature ?? this.defaultTemperature,
      system: req.system ? [{ type: 'text', text: req.system, ...(this.promptCache ? EPHEMERAL : {}) }] : undefined,
      messages: anthropicMessages,
      tools: (req.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
    };
    const response = await this.client.messages.create(params as never, { signal: req.signal });
    req.signal?.throwIfAborted();

    let text = '';
    const toolCalls: LlmToolCall[] = [];
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }

    const stopReason: LlmCompleteResponse['stopReason'] =
      response.stop_reason === 'end_turn'
        ? 'end_turn'
        : response.stop_reason === 'tool_use'
          ? 'tool_use'
          : response.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : 'other';

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        cacheReadTokens: cacheTokens(response.usage, 'cache_read_input_tokens'),
        cacheWriteTokens: cacheTokens(response.usage, 'cache_creation_input_tokens'),
      },
    };
  }
}

function cacheTokens(usage: unknown, key: 'cache_read_input_tokens' | 'cache_creation_input_tokens'): number | undefined {
  const v = (usage as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'number' ? v : undefined;
}

/** Puts a cache breakpoint on the last non-empty block of the last message. */
function markLastBlock(messages: Anthropic.MessageParam[]): void {
  const last = messages.at(-1);
  if (!last) return;
  if (typeof last.content === 'string') {
    if (last.content) last.content = [{ type: 'text', text: last.content, ...EPHEMERAL }] as never;
    return;
  }
  const block = [...last.content].reverse().find((b) => !(b.type === 'text' && !b.text));
  if (block) Object.assign(block, EPHEMERAL);
}
