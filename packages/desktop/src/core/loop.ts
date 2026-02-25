import { streamCompletion } from "./openrouter";
import { streamCodexCompletion } from "./codex";
import { truncateToolResult } from "./truncate";
import { error as logError, warn as logWarn, debug as logDebug, formatError } from "../log";
import type { ChatLoopOptions, StreamResult, ToolDefinition, StreamEvent } from "./types";

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

/** Dispatch streaming to the correct provider. */
function callProvider(
  options: ChatLoopOptions,
  messages: Array<Record<string, unknown>>,
  tools: ToolDefinition[] | undefined,
  onEvent: (event: StreamEvent) => void,
): Promise<StreamResult> {
  if (options.provider === "codex" && options.codexAuth) {
    return streamCodexCompletion({
      accessToken: options.codexAuth.accessToken,
      accountId: options.codexAuth.accountId,
      model: options.params?.model ?? options.model,
      messages,
      params: options.params,
      tools,
      signal: options.signal,
      convId: options.convId,
      onEvent,
    });
  }
  return streamCompletion({
    apiKey: options.apiKey,
    model: options.model,
    messages,
    params: options.params,
    tools,
    signal: options.signal,
    onEvent,
  });
}

export async function runChatLoop(options: ChatLoopOptions): Promise<void> {
  const {
    messages,
    systemPrompt,
    maxToolRoundtrips = Infinity,
    signal,
    cwd,
    convId,
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
      logWarn(`[loop] Doom loop detected: ${toolCallHistory.slice(-1)[0]?.toolName} called 3x with same args`);
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
        const finalResult = await callProvider(options, workingMessages, undefined, onEvent);
        onEvent({ type: "finish", usage: finalResult.usage });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        logError(`[loop] Doom loop recovery failed: ${formatError(e)}`);
        onEvent({ type: "error", error: formatError(e) });
      }
      return;
    }

    let result: StreamResult;
    try {
      result = await callProvider(
        options,
        workingMessages,
        currentTools.length > 0 ? currentTools : undefined,
        onEvent,
      );
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      logError(`[loop] API call failed (round ${round}): ${formatError(e)}`);
      onEvent({ type: "error", error: formatError(e) });
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
              const execResult = await invalidTool.execute(errorArgs, { signal, cwd, convId });
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
          logDebug(`[loop] Executing tool: ${tc.name}`);
          // Validate args against tool JSON schema before execution
          const { validateToolArgs } = await import("./tools/validate");
          const validationError = validateToolArgs(tool.parameters as Record<string, any>, tc.args);
          if (validationError) {
            const errorResult = { error: validationError };
            onEvent({
              type: "tool-result",
              toolCallId: tc.id,
              toolName: tc.name,
              result: errorResult,
              isError: true,
            });
            return { toolCallId: tc.id, result: errorResult, isError: true };
          }

          const execResult = await tool.execute(tc.args, { signal, cwd, convId });
          onEvent({
            type: "tool-result",
            toolCallId: tc.id,
            toolName: tc.name,
            result: execResult,
            isError: false,
          });
          return { toolCallId: tc.id, result: execResult, isError: false };
        } catch (e) {
          logError(`[loop] Tool "${tc.name}" threw: ${formatError(e)}`);
          const errorResult = { error: e instanceof Error ? e.message : String(e) };
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
