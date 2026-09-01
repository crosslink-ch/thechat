import type {
  AcpCapabilities,
  AcpError,
  AcpEvent,
  AcpPermissionRequest,
  AcpToolCall,
  AcpToolCallUpdate,
  AcpTurnResult,
  MessagePart,
} from "@thechat/shared";

export type AcpEventStatus =
  | "idle"
  | "ready"
  | "running"
  | "cancelling"
  | "finished"
  | "cancelled"
  | "error"
  | "disconnected";

export interface AcpEventState {
  conversationId: string;
  generation: number;
  lastSequence: number;
  turnId: string | null;
  status: AcpEventStatus;
  parts: MessagePart[];
  pendingPermissions: AcpPermissionRequest[];
  capabilities: AcpCapabilities | null;
  result: AcpTurnResult | null;
  error: AcpError | null;
  /** Accepted non-rendered updates (plan, commands, modes, config, unknown). */
  updates: AcpEvent[];
  ignoredEvents: number;
}

const TERMINAL_STATUSES = new Set<AcpEventStatus>([
  "finished",
  "cancelled",
  "error",
  "disconnected",
]);

const CANCELLATION_TERMINAL_EVENTS = new Set<AcpEvent["type"]>([
  "turn_cancelled",
  "turn_finished",
  "error",
  "disconnected",
]);

export function createAcpEventState(
  conversationId: string,
  generation: number,
  capabilities: AcpCapabilities | null = null,
): AcpEventState {
  return {
    conversationId,
    generation,
    lastSequence: 0,
    turnId: null,
    status: capabilities ? "ready" : "idle",
    parts: [],
    pendingPermissions: [],
    capabilities,
    result: null,
    error: null,
    updates: [],
    ignoredEvents: 0,
  };
}

/**
 * Pure generation-safe reducer for one conversation.
 *
 * Sequence numbers are strictly monotonic: once a later event is accepted, a
 * delayed earlier event is ignored. Terminal turns are sealed against content
 * replay, while a later lifecycle disconnect may still supersede them.
 */
export function reduceAcpEvent(
  state: AcpEventState,
  event: AcpEvent,
): AcpEventState {
  if (
    event.conversationId !== state.conversationId ||
    event.generation !== state.generation ||
    event.sequence <= state.lastSequence
  ) {
    return { ...state, ignoredEvents: state.ignoredEvents + 1 };
  }
  if (TERMINAL_STATUSES.has(state.status) && event.type !== "disconnected") {
    return { ...state, ignoredEvents: state.ignoredEvents + 1 };
  }
  if (
    state.status === "cancelling" &&
    !CANCELLATION_TERMINAL_EVENTS.has(event.type)
  ) {
    return { ...state, ignoredEvents: state.ignoredEvents + 1 };
  }

  const next: AcpEventState = {
    ...state,
    lastSequence: event.sequence,
    turnId: event.turnId ?? state.turnId,
  };

  switch (event.type) {
    case "connected":
      return {
        ...next,
        status: "ready",
        capabilities: event.capabilities,
      };
    case "turn_started":
      return {
        ...next,
        status: "running",
        parts: [],
        pendingPermissions: [],
        result: null,
        error: null,
        updates: [],
      };
    case "reasoning_delta":
      return {
        ...next,
        status: "running",
        parts: appendDelta(state.parts, "reasoning", event.text),
      };
    case "text_delta":
      return {
        ...next,
        status: "running",
        parts: appendDelta(state.parts, "text", event.text),
      };
    case "tool_call":
      return {
        ...next,
        status: "running",
        parts: upsertTool(state.parts, event.toolCall.id, event.toolCall),
      };
    case "tool_call_update":
      return {
        ...next,
        status: "running",
        parts: upsertTool(state.parts, event.toolCallId, event.update),
      };
    case "permission_request":
      return {
        ...next,
        status: "running",
        pendingPermissions: upsertPermission(
          state.pendingPermissions,
          event.permission,
        ),
      };
    case "permission_resolved":
      return {
        ...next,
        pendingPermissions: state.pendingPermissions.filter(
          (request) => request.id !== event.requestId,
        ),
      };
    case "turn_cancelled":
      return {
        ...next,
        status: "cancelled",
        pendingPermissions: [],
        result: event.result,
      };
    case "turn_finished":
      return {
        ...next,
        status: "finished",
        pendingPermissions: [],
        result: event.result,
      };
    case "error":
      if (event.error.fatal === false) {
        return {
          ...next,
          status: state.status,
          error: event.error,
        };
      }
      return {
        ...next,
        status: "error",
        pendingPermissions: [],
        error: event.error,
        result: null,
      };
    case "disconnected":
      return {
        ...next,
        status: "disconnected",
        pendingPermissions: [],
        error: event.reason
          ? { code: "disconnected", message: event.reason, fatal: true }
          : state.error,
      };
    case "plan_update":
    case "command_update":
    case "mode_update":
    case "config_option_update":
    case "unknown":
      return { ...next, updates: [...state.updates, event] };
  }
}

function appendDelta(
  parts: MessagePart[],
  type: "text" | "reasoning",
  text: string,
): MessagePart[] {
  if (!text) return parts;
  const next = [...parts];
  const last = next[next.length - 1];
  if (last?.type === type) {
    next[next.length - 1] = { type, text: last.text + text };
  } else {
    next.push({ type, text });
  }
  return next;
}

function upsertPermission(
  permissions: AcpPermissionRequest[],
  permission: AcpPermissionRequest,
): AcpPermissionRequest[] {
  const index = permissions.findIndex((candidate) => candidate.id === permission.id);
  if (index < 0) return [...permissions, permission];
  const next = [...permissions];
  next[index] = permission;
  return next;
}

function upsertTool(
  parts: MessagePart[],
  toolCallId: string,
  update: AcpToolCall | AcpToolCallUpdate,
): MessagePart[] {
  const callIndex = parts.findIndex(
    (part) => part.type === "tool-call" && part.toolCallId === toolCallId,
  );
  const existing =
    callIndex >= 0 && parts[callIndex].type === "tool-call"
      ? parts[callIndex]
      : null;
  const merged: AcpToolCall = {
    id: toolCallId,
    ...(existing?.acp ?? {}),
    ...update,
  };
  const toolName = merged.name ?? existing?.toolName ?? "tool";
  const args = isRecord(merged.rawInput)
    ? merged.rawInput
    : existing?.args ?? {};
  const callPart: MessagePart = {
    type: "tool-call",
    toolCallId,
    toolName,
    args,
    acp: merged,
  };

  const next = [...parts];
  if (callIndex >= 0) next[callIndex] = callPart;
  else next.push(callPart);

  if (!isTerminalTool(merged)) return next;

  const resultIndex = next.findIndex(
    (part) => part.type === "tool-result" && part.toolCallId === toolCallId,
  );
  const resultPart: MessagePart = {
    type: "tool-result",
    toolCallId,
    toolName,
    result: merged.rawOutput ?? merged.content ?? null,
    isError: merged.status === "failed" || merged.status === "cancelled",
    acp: merged,
  };
  if (resultIndex >= 0) next[resultIndex] = resultPart;
  else next.push(resultPart);
  return next;
}

function isTerminalTool(tool: AcpToolCall) {
  return (
    tool.status === "completed" ||
    tool.status === "failed" ||
    tool.status === "cancelled"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
