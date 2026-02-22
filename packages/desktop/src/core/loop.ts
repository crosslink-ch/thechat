import { streamCompletion } from "./openrouter";
import { truncateToolResult } from "./truncate";
import type { ChatLoopOptions, StreamResult, ToolDefinition } from "./types";

const DEFAULT_SYSTEM_PROMPT = `\
You are a helpful assistant. \
Be concise and direct in your responses. \
When using tools, explain what you're doing briefly.`;

const DOOM_LOOP_THRESHOLD = 3;

interface ToolCallRecord {
  toolName: string;
  argsJson: string;
}

/**
 * Detect doom loops: the last N tool calls are the same tool with identical args.
 */
function isDoomLoop(history: ToolCallRecord[]): boolean {
  if (history.length < DOOM_LOOP_THRESHOLD) return false;
  const recent = history.slice(-DOOM_LOOP_THRESHOLD);
  const first = recent[0];
  return recent.every(
    (r) => r.toolName === first.toolName && r.argsJson === first.argsJson,
  );
}

/**
 * Resolve the current set of tools, preferring the dynamic getTools() provider.
 */
function resolveTools(options: ChatLoopOptions): ToolDefinition[] {
  return options.getTools?.() ?? options.tools ?? [];
}

export async function runChatLoop(options: ChatLoopOptions): Promise<void> {
  const {
    apiKey,
    model,
    messages,
    systemPrompt,
    params,
    maxToolRoundtrips = Infinity,
    signal,
    onEvent,
  } = options;

  const workingMessages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
    ...messages,
  ];

  const toolCallHistory: ToolCallRecord[] = [];

  for (let round = 0; round <= maxToolRoundtrips; round++) {
    if (signal?.aborted) return;

    // Rebuild tool map each iteration so newly-loaded MCP tools are picked up
    const currentTools = resolveTools(options);
    const toolMap = new Map<string, ToolDefinition>();
    for (const t of currentTools) {
      toolMap.set(t.name, t);
    }

    // Doom loop detected — do one final text-only call so the model can respond
    if (isDoomLoop(toolCallHistory)) {
      onEvent({
        type: "error",
        error: "Doom loop detected: the same tool was called with identical arguments 3 times in a row. Requesting text-only response.",
      });

      workingMessages.push({
        role: "user",
        content:
          "You appear to be stuck in a loop, repeating the same tool call with the same arguments. " +
          "Stop using tools and provide your best response with the information you have so far.",
      });

      try {
        const finalResult = await streamCompletion({
          apiKey,
          model,
          messages: workingMessages,
          params,
          tools: undefined, // no tools — force text-only
          signal,
          onEvent,
        });
        onEvent({ type: "finish", usage: finalResult.usage });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        onEvent({ type: "error", error: String(e) });
      }
      return;
    }

    let result: StreamResult;
    try {
      result = await streamCompletion({
        apiKey,
        model,
        messages: workingMessages,
        params,
        tools: currentTools.length > 0 ? currentTools : undefined,
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

    // Track tool calls for doom loop detection
    for (const tc of result.toolCalls) {
      toolCallHistory.push({
        toolName: tc.name,
        argsJson: JSON.stringify(tc.args),
      });
    }

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

  // Exceeded max roundtrips (only reachable if explicitly set)
  onEvent({ type: "error", error: `Exceeded maximum tool roundtrips (${maxToolRoundtrips})` });
}
