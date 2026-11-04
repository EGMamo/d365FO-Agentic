/**
 * Provider-agnostic LLM interface used by the agent orchestrator.
 *
 * A tool call is any structured action the model wants us to dispatch — most
 * often an MCP tool invocation. Providers translate between their native
 * tool-use formats and these shared shapes.
 */

export interface LlmToolParameter {
  name: string;
  description?: string;
  schema: Record<string, unknown>;
}

export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** For assistant messages that requested tool calls. */
  toolCalls?: LlmToolCall[];
  /** For tool-result messages. */
  toolCallId?: string;
  toolName?: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmCompleteRequest {
  /** Cancels an in-flight provider request when the run stops. */
  signal?: AbortSignal;
  system?: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxTokens?: number;
  temperature?: number;
}

export interface LlmCompleteResponse {
  /** Assistant text content, may be empty when only tool calls are returned. */
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse>;
}
