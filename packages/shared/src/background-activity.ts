export type BackgroundParentState = "working" | "waiting_worker" | "waiting_user" | "waiting_external" | "verifying" | "finished" | "failed" | "stopped" | "unknown";
export interface BackgroundWorker {
  id: string; kind: "subagent" | "process"; parentId: string | null; goal: string;
  state: "running" | "waiting" | "finished" | "failed" | "stopped" | "unknown";
  action: string | null; startedAt: string; updatedAt: string; lastActionAt: string | null;
}
export interface BackgroundToolActivity {
  id: string; workerId: string | null; toolName: string;
  state: "running" | "finished" | "failed" | "stopped" | "unknown";
  startedAt: string; finishedAt: string | null;
}
export interface BackgroundActivityInput {
  schemaVersion: 1; eventId: string; taskId: string; sequence: number;
  originInvocationId: string; sessionId: string; occurredAt: string;
  parent: {state: BackgroundParentState; action: string | null; updatedAt: string};
  workers: BackgroundWorker[]; activities: BackgroundToolActivity[];
}
export interface BackgroundActivityPublic extends Omit<BackgroundActivityInput, "schemaVersion" | "eventId" | "occurredAt"> {
  botId: string; botUserId: string; botName: string; conversationId: string;
  threadId: string | null; observedAt: string; canStop?: boolean;
}
export const backgroundTaskTerminal = (state: BackgroundParentState) =>
  state === "finished" || state === "failed" || state === "stopped";
