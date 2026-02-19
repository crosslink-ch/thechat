import type { ChatParams, StreamEvent, StreamResult, ToolDefinition } from "./types";

interface StreamCompletionOptions {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  params?: ChatParams;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}

export async function streamCompletion(options: StreamCompletionOptions): Promise<StreamResult> {
  const { apiKey, model, messages, params, tools, signal, onEvent } = options;

  // Build request body
  const body: Record<string, unknown> = {
    model: params?.model ?? model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  // Pass through optional params
  if (params?.temperature !== undefined) body.temperature = params.temperature;
  if (params?.top_p !== undefined) body.top_p = params.top_p;
  if (params?.top_k !== undefined) body.top_k = params.top_k;
  if (params?.max_tokens !== undefined) body.max_tokens = params.max_tokens;
  if (params?.frequency_penalty !== undefined) body.frequency_penalty = params.frequency_penalty;
  if (params?.presence_penalty !== undefined) body.presence_penalty = params.presence_penalty;
  if (params?.stop !== undefined) body.stop = params.stop;
  if (params?.tool_choice !== undefined) body.tool_choice = params.tool_choice;
  if (params?.response_format !== undefined) body.response_format = params.response_format;
  if (params?.reasoning_effort !== undefined) body.reasoning_effort = params.reasoning_effort;
  if (params?.thinking !== undefined) body.thinking = params.thinking;
  if (params?.seed !== undefined) body.seed = params.seed;
  if (params?.provider !== undefined) body.provider = params.provider;

  // Add tool definitions if provided
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`OpenRouter API error (${response.status}): ${errBody}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let accText = "";
  let accReasoning = "";
  let usage: StreamResult["usage"] = undefined;

  // Tool call accumulation: indexed by tool call index within the response
  const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);

        // Parse usage from final chunk
        if (parsed.usage) {
          usage = {
            prompt_tokens: parsed.usage.prompt_tokens,
            completion_tokens: parsed.usage.completion_tokens,
            total_tokens: parsed.usage.total_tokens,
          };
        }

        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        // Reasoning content
        if (delta.reasoning) {
          accReasoning += delta.reasoning;
          onEvent({ type: "reasoning-delta", text: delta.reasoning });
        }
        if (delta.reasoning_details) {
          for (const detail of delta.reasoning_details) {
            if (detail.type === "thinking" && detail.thinking) {
              accReasoning += detail.thinking;
              onEvent({ type: "reasoning-delta", text: detail.thinking });
            }
          }
        }

        // Text content
        if (delta.content) {
          accText += delta.content;
          onEvent({ type: "text-delta", text: delta.content });
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            let accum = toolCallAccum.get(idx);

            if (!accum) {
              accum = { id: tc.id || "", name: tc.function?.name || "", args: "" };
              toolCallAccum.set(idx, accum);
            }

            if (tc.id) accum.id = tc.id;
            if (tc.function?.name) {
              accum.name = tc.function.name;
              onEvent({ type: "tool-call-start", toolCallId: accum.id, toolName: accum.name });
            }
            if (tc.function?.arguments) {
              accum.args += tc.function.arguments;
              onEvent({ type: "tool-call-args-delta", toolCallId: accum.id, args: tc.function.arguments });
            }
          }
        }
      } catch {
        // Skip malformed JSON chunks
      }
    }
  }

  // Emit tool-call-complete events for all accumulated tool calls
  const toolCalls = Array.from(toolCallAccum.values()).map((tc) => {
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(tc.args);
    } catch {
      // If args don't parse, keep empty object
    }
    onEvent({
      type: "tool-call-complete",
      toolCallId: tc.id,
      toolName: tc.name,
      args: parsedArgs,
    });
    return { id: tc.id, name: tc.name, args: parsedArgs };
  });

  return { text: accText, reasoning: accReasoning, toolCalls, usage };
}
