import type { MessagePart } from "@thechat/shared";
import { formatToolSummary } from "./tool-summary";

type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>;

export type ActivityPhase =
  | "starting"
  | "thinking"
  | "working"
  | "responding"
  | "waiting-permission";

export interface Activity {
  phase: ActivityPhase;
  details: string[];
}

export function deriveActivity(
  parts: MessagePart[],
  hasPendingPermission: boolean,
): Activity {
  if (hasPendingPermission) {
    return { phase: "waiting-permission", details: [] };
  }

  if (parts.length === 0) {
    return { phase: "starting", details: [] };
  }

  // Find tool-calls without matching tool-results → active tools
  const resultIds = new Set<string>();
  for (const p of parts) {
    if (p.type === "tool-result") resultIds.add(p.toolCallId);
  }

  const activeToolCalls: ToolCallPart[] = [];
  for (const p of parts) {
    if (p.type === "tool-call" && !resultIds.has(p.toolCallId)) {
      activeToolCalls.push(p as ToolCallPart);
    }
  }

  if (activeToolCalls.length > 0) {
    const details = activeToolCalls
      .slice(-3)
      .map((tc) => formatToolSummary(tc));
    return { phase: "working", details };
  }

  // Check last part type
  const lastPart = parts[parts.length - 1];
  if (lastPart.type === "reasoning") {
    return { phase: "thinking", details: [] };
  }
  if (lastPart.type === "text") {
    return { phase: "responding", details: [] };
  }

  // After tool results, before next action
  return { phase: "thinking", details: [] };
}
