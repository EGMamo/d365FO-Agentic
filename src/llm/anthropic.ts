import Anthropic from '@anthropic-ai/sdk';
import type {
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmProvider,
  LlmToolCall,
} from './types.js';

/**
 * Anthropic Claude adapter. Uses the official SDK's tool-use protocol and
 * projects it onto the shared `LlmProvider` shape.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  private model: string;
  private defaultMaxTokens: number;
  private defaultTemperature: number;

  constructor(opts: { apiKey: string; model: string; maxTokens: number; temperature: number }) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.defaultMaxTokens = opts.maxTokens;
    this.defaultTemperature = opts.temperature;
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
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

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      temperature: req.temperature ?? this.defaultTemperature,
      system: req.system,
      messages: anthropicMessages,
      tools: (req.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
    });

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
      },
    };
  }
}
