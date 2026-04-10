import { streamChatCompletion } from "./chat-completions";
import type { ChatParams, StreamEvent, StreamResult, ToolDefinition } from "./types";

interface StreamCompletionOptions {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  params?: ChatParams;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  onEvents: (events: StreamEvent[]) => void;
}

export async function streamCompletion(options: StreamCompletionOptions): Promise<StreamResult> {
  return streamChatCompletion({
    ...options,
    url: "https://openrouter.ai/api/v1/chat/completions",
    providerTag: "openrouter",
    streamIdPrefix: "or_",
  });
}
