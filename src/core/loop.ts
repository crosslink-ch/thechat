import { streamCompletion } from "./openrouter";
import { truncateToolResult } from "./truncate";
import type { ChatLoopOptions, StreamResult, ToolDefinition } from "./types";

const DEFAULT_SYSTEM_PROMPT = `\
You are a helpful assistant. \
Be concise and direct in your responses. \
When using tools, explain what you're doing briefly.`;

export async function runChatLoop(options: ChatLoopOptions): Promise<void> {
  const {
    apiKey,
    model,
    messages,
    systemPrompt,
    params,
    tools,
    maxToolRoundtrips = 20,
    signal,
    onEvent,
  } = options;

  const workingMessages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    ...messages,
  ];
  const toolMap = new Map<string, ToolDefinition>();
  if (tools) {
    for (const t of tools) {
      toolMap.set(t.name, t);
    }
  }

  for (let round = 0; round <= maxToolRoundtrips; round++) {
    if (signal?.aborted) return;

    let result: StreamResult;
    try {
      result = await streamCompletion({
        apiKey,
        model,
        messages: workingMessages,
        params,
        tools,
        signal,
        onEvent,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      onEvent({ type: "error", error: String(e) });
      return;
    }

    // No tool calls → we're done
    if (result.toolCalls.length === 0) {
      onEvent({ type: "finish", usage: result.usage });
      return;
    }

    // Append assistant message with tool_calls to working messages
    const assistantMessage: Record<string, unknown> = { role: "assistant" };
    if (result.text) assistantMessage.content = result.text;
    assistantMessage.tool_calls = result.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }));
    workingMessages.push(assistantMessage);

    // Execute all tool calls in parallel
    const toolResults = await Promise.all(
      result.toolCalls.map(async (tc) => {
        let tool = toolMap.get(tc.name);

        // Invalid tool injection: redirect unknown tools to the "invalid" tool
        if (!tool) {
          const invalidTool = toolMap.get("invalid");
          if (invalidTool) {
            const availableNames = Array.from(toolMap.keys())
              .filter((n) => n !== "invalid")
              .join(", ");
            const errorArgs = {
              error: `Unknown tool "${tc.name}". Available tools: ${availableNames}`,
            };
            try {
              const execResult = await invalidTool.execute(errorArgs);
              onEvent({
                type: "tool-result",
                toolCallId: tc.id,
                toolName: tc.name,
                result: execResult,
                isError: true,
              });
              return { toolCallId: tc.id, result: execResult, isError: true };
            } catch {
              // Fall through to generic error
            }
          }

          const errorResult = { error: `Unknown tool: ${tc.name}` };
          onEvent({
            type: "tool-result",
            toolCallId: tc.id,
            toolName: tc.name,
            result: errorResult,
            isError: true,
          });
          return { toolCallId: tc.id, result: errorResult, isError: true };
        }

        try {
          const execResult = await tool.execute(tc.args);
          onEvent({
            type: "tool-result",
            toolCallId: tc.id,
            toolName: tc.name,
            result: execResult,
            isError: false,
          });
          return { toolCallId: tc.id, result: execResult, isError: false };
        } catch (e) {
          const errorResult = { error: String(e) };
          onEvent({
            type: "tool-result",
            toolCallId: tc.id,
            toolName: tc.name,
            result: errorResult,
            isError: true,
          });
          return { toolCallId: tc.id, result: errorResult, isError: true };
        }
      }),
    );

    // Append tool result messages (with truncation)
    for (const tr of toolResults) {
      const content = JSON.stringify(tr.result);
      workingMessages.push({
        role: "tool",
        tool_call_id: tr.toolCallId,
        content: truncateToolResult(content),
      });
    }

    // Continue loop — model will see tool results
  }

  // Exceeded max roundtrips
  onEvent({ type: "error", error: `Exceeded maximum tool roundtrips (${maxToolRoundtrips})` });
}
