// Re-export shared types (zero import changes across the desktop codebase)
export type {
  MessagePart,
  Message,
  DbMessage,
  Conversation,
  AppConfig,
  TodoItem,
  ChatParams,
  StreamEvent,
  ToolCallResult,
  StreamResult,
} from "@thechat/shared";

import type { ChatParams, StreamEvent } from "@thechat/shared";

// -- MCP Tool Info (from backend) --

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// -- Question Types --

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
}

export interface QuestionRequest {
  id: string;
  questions: QuestionInfo[];
  resolve: (answers: string[][]) => void;
  reject: (reason: string) => void;
}

// -- Tool Definition --

export interface ToolExecutionContext {
  signal?: AbortSignal;
  cwd?: string;
  convId?: string;
}

export interface ToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute: (args: TArgs, context?: ToolExecutionContext) => unknown | Promise<unknown>;
}

// -- Chat Loop Options --

export interface CodexAuth {
  accessToken: string;
  accountId: string;
}

export interface ChatLoopOptions {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  systemPrompt?: string;
  params?: ChatParams;
  tools?: ToolDefinition[];
  getTools?: () => ToolDefinition[];
  maxToolRoundtrips?: number;
  signal?: AbortSignal;
  cwd?: string;
  convId?: string;
  provider?: "openrouter" | "codex" | "glm" | "featherless";
  codexAuth?: CodexAuth;
  glmApiKey?: string;
  glmPlanType?: "coding" | "standard";
  featherlessApiKey?: string;
  getQueuedMessages?: () => Array<{ id: string; content: string }>;
  onEvents: (events: StreamEvent[]) => void;
}
