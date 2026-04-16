import { streamChatCompletion } from "./chat-completions";
import type { ChatParams, StreamEvent, StreamResult, ToolDefinition } from "./types";

interface StreamFeatherlessOptions {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  params?: ChatParams;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  onEvents: (events: StreamEvent[]) => void;
}

export async function streamFeatherlessCompletion(options: StreamFeatherlessOptions): Promise<StreamResult> {
  return streamChatCompletion({
    ...options,
    url: "https://api.featherless.ai/v1/chat/completions",
    providerTag: "featherless",
    streamIdPrefix: "fl_",
  });
}
