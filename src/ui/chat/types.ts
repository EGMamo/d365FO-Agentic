import type { LlmMessage, LlmTool } from '../../llm/types.js';

/** A persisted chat message. Tool calls/results are retained so a later turn has the full model context. */
export interface ChatMessage extends LlmMessage {
  id: string;
  at: string;
}

export interface ChatConversation {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatRepository {
  list(): Promise<ChatSummary[]>;
  get(id: string): Promise<ChatConversation>;
  create(title?: string): Promise<ChatConversation>;
  rename(id: string, title: string): Promise<ChatConversation>;
  append(id: string, messages: Array<Omit<ChatMessage, 'id' | 'at'>>): Promise<ChatConversation>;
  delete(id: string): Promise<void>;
}

export interface ChatTool {
  definition: LlmTool;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export type ChatEvent =
  | { type: 'status'; text: string }
  | { type: 'message'; conversation: ChatConversation }
  | { type: 'tool'; name: string; status: 'running' | 'finished' | 'failed'; detail?: string }
  | { type: 'done'; conversation: ChatConversation }
  | { type: 'error'; message: string };
