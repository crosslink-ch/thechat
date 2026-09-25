import type { ChatMessage } from "@thechat/shared";

/**
 * During long runs Hermes posts keep-alive messages such as
 * "⏳ Working — 3 min — iteration 14/2000, mcp__composio__COMPOSIO_SEARCH_TOOLS".
 * They arrive as ordinary chat messages, so the chat folds them into a single
 * "Worked for …" line on the answer that follows them.
 */
export interface KeepAliveUpdate {
  messageId: string;
  createdAt: string;
  /** Elapsed run time the update reported, when it included one. */
  elapsedSeconds: number | null;
  /** "14/2000" */
  iteration: string | null;
  tool: string | null;
}

export interface KeepAliveRun {
  updates: KeepAliveUpdate[];
  /** Run duration, or elapsed time so far while it is still going. */
  durationMs: number | null;
  /** True when the start time comes from the triggering message. */
  exact: boolean;
}

export type FoldedChatItem =
  | { kind: "message"; message: ChatMessage; run?: KeepAliveRun }
  /** Keep-alives with no answer yet; `message` is the latest update. */
  | { kind: "working"; message: ChatMessage; run: KeepAliveRun };

const KEEP_ALIVE = /^[⏳⌛]️?\s*working\b/i;

export function parseKeepAlive(message: ChatMessage): KeepAliveUpdate | null {
  if (message.senderType !== "bot" || message.attachments?.length) return null;
  const text = message.content.trim();
  if (!KEEP_ALIVE.test(text) || text.includes("\n") || text.length > 400) return null;

  const minutes = /(\d+)\s*min/i.exec(text);
  const seconds = /(\d+)\s*s(?:ec(?:onds?)?)?\b/i.exec(text);
  const elapsedSeconds =
    minutes || seconds
      ? Number(minutes?.[1] ?? 0) * 60 + Number(seconds?.[1] ?? 0)
      : null;
  const iteration = /iteration\s+(\d+(?:\s*\/\s*\d+)?)/i.exec(text);
  const tool = /iteration\s+\d+(?:\s*\/\s*\d+)?\s*,\s*(.+)$/i.exec(text);

  return {
    messageId: message.id,
    createdAt: message.createdAt,
    elapsedSeconds,
    iteration: iteration ? iteration[1].replace(/\s+/g, "") : null,
    tool: tool ? tool[1].trim() : null,
  };
}

/**
 * Hides keep-alive messages and attaches them to the next message from the
 * same bot. Keep-alives with no answer yet become a trailing "working" item.
 */
export function foldHermesKeepAlives(
  messages: ChatMessage[],
  nowMs = Date.now(),
): FoldedChatItem[] {
  const items: FoldedChatItem[] = [];
  const pending = new Map<
    string,
    { updates: KeepAliveUpdate[]; latest: ChatMessage; trigger?: ChatMessage }
  >();
  let lastMessage: ChatMessage | undefined;

  for (const message of messages) {
    const update = parseKeepAlive(message);
    if (update) {
      const group = pending.get(message.senderId);
      if (group) {
        group.updates.push(update);
        group.latest = message;
      } else {
        pending.set(message.senderId, {
          updates: [update],
          latest: message,
          trigger: lastMessage?.senderId !== message.senderId ? lastMessage : undefined,
        });
      }
      continue;
    }

    const group = message.senderType === "bot" ? pending.get(message.senderId) : undefined;
    if (group) pending.delete(message.senderId);
    items.push(
      group
        ? {
            kind: "message",
            message,
            run: keepAliveRun(group.updates, group.trigger, Date.parse(message.createdAt)),
          }
        : { kind: "message", message },
    );
    lastMessage = message;
  }

  for (const group of pending.values()) {
    items.push({
      kind: "working",
      message: group.latest,
      run: keepAliveRun(group.updates, group.trigger, nowMs),
    });
  }
  return items;
}

function keepAliveRun(
  updates: KeepAliveUpdate[],
  trigger: ChatMessage | undefined,
  endMs: number,
): KeepAliveRun {
  const first = updates[0];
  const firstAt = Date.parse(first.createdAt);
  if (!Number.isFinite(firstAt) || !Number.isFinite(endMs)) {
    return { updates, durationMs: null, exact: false };
  }
  const estimatedStart = firstAt - (first.elapsedSeconds ?? 0) * 1000;
  const triggerAt = trigger ? Date.parse(trigger.createdAt) : Number.NaN;
  // The triggering message pins the exact start when it fits the elapsed time
  // the first update reported (updates round down to whole minutes).
  const exact =
    Number.isFinite(triggerAt) &&
    triggerAt <= firstAt &&
    triggerAt >= estimatedStart - 90_000;
  const start = exact ? triggerAt : estimatedStart;
  return { updates, durationMs: Math.max(0, endMs - start), exact };
}

/** "5m 56s", or whole minutes when only an estimate is known. */
export function formatRunDuration(run: KeepAliveRun): string | null {
  if (run.durationMs === null) return null;
  const totalSeconds = Math.round(run.durationMs / 1000);
  if (!run.exact) {
    const minutes = Math.max(1, Math.round(totalSeconds / 60));
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "mcp__composio__COMPOSIO_SEARCH_TOOLS" → "Composio search tools". */
export function humanizeToolName(tool: string): string {
  const name = tool.split("__").pop() ?? tool;
  const words = name.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : tool;
}
