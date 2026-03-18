import { useState, useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/shallow";
import type { MessagePart } from "../core/types";

// --- Plain JS layer (no React involvement) ---

// Accumulated parts per conversation — plain JS Map, not in Zustand
const accumulatedParts = new Map<string, MessagePart[]>();
const listeners = new Map<string, Set<(parts: MessagePart[] | null) => void>>();

// Timestamp tracking — plain JS, no React involvement
const streamStartTimes = new Map<string, number>();
const toolCallTimestamps = new Map<string, Map<string, number>>();

export function getStreamStartTime(convId: string): number | null {
  return streamStartTimes.get(convId) ?? null;
}

export function getToolCallStartTime(convId: string, toolCallId: string): number | null {
  return toolCallTimestamps.get(convId)?.get(toolCallId) ?? null;
}

export function recordToolCallStart(convId: string, toolCallId: string): void {
  let convMap = toolCallTimestamps.get(convId);
  if (!convMap) {
    convMap = new Map();
    toolCallTimestamps.set(convId, convMap);
  }
  if (!convMap.has(toolCallId)) {
    convMap.set(toolCallId, Date.now());
  }
}

/**
 * Called from useChat onEvents — stores parts and notifies active listeners.
 * Accepts the mutable array directly (no copy needed from caller).
 * Only copies when there are active subscribers (foreground chat) so
 * React sees a new reference. Background chats store the reference as-is,
 * avoiding per-batch allocations.
 */
export function updateStreamParts(convId: string, parts: MessagePart[]) {
  const subs = listeners.get(convId);
  if (subs && subs.size > 0) {
    const snapshot = [...parts];
    accumulatedParts.set(convId, snapshot);
    for (const fn of subs) fn(snapshot);
  } else {
    accumulatedParts.set(convId, parts);
  }
}

/** Returns a snapshot copy (safe to use as React state when subscriber joins mid-stream) */
export function getStreamParts(convId: string): MessagePart[] | null {
  const parts = accumulatedParts.get(convId);
  return parts ? [...parts] : null;
}

export function subscribeToStream(
  convId: string,
  listener: (parts: MessagePart[] | null) => void,
): () => void {
  let subs = listeners.get(convId);
  if (!subs) {
    subs = new Set();
    listeners.set(convId, subs);
  }
  subs.add(listener);
  return () => {
    subs!.delete(listener);
    if (subs!.size === 0) listeners.delete(convId);
  };
}

// --- Zustand store — only tracks streamingConvIds ---

interface StreamingStore {
  streamingConvIds: Set<string>;
  startStreaming: (convId: string) => void;
  stopStreaming: (convId: string) => void;
}

export const useStreamingStore = create<StreamingStore>()((set) => ({
  streamingConvIds: new Set(),

  startStreaming: (convId) => {
    accumulatedParts.set(convId, []);
    streamStartTimes.set(convId, Date.now());
    // Notify existing subscribers so the typing indicator shows on
    // subsequent messages in the same conversation (convId unchanged →
    // useEffect won't re-run → subscribers from the previous stream
    // are still active but holding stale null state from stopStreaming).
    const subs = listeners.get(convId);
    if (subs) {
      for (const fn of subs) fn([]);
    }
    set((state) => {
      const streamingConvIds = new Set(state.streamingConvIds);
      streamingConvIds.add(convId);
      return { streamingConvIds };
    });
  },

  stopStreaming: (convId) => {
    // Notify subscribers that streaming is done so React state clears
    // and StreamingMessage unmounts. Don't delete listeners — the React
    // useEffect cleanup handles that. Deleting here would break the next
    // stream in the same conversation (convId unchanged → useEffect won't
    // re-run → no new subscription).
    const subs = listeners.get(convId);
    if (subs) {
      for (const fn of subs) fn(null);
    }
    accumulatedParts.delete(convId);
    streamStartTimes.delete(convId);
    toolCallTimestamps.delete(convId);
    set((state) => {
      const streamingConvIds = new Set(state.streamingConvIds);
      streamingConvIds.delete(convId);
      return { streamingConvIds };
    });
  },
}));

// --- React hooks ---

/** Subscribes to streaming parts only when mounted for that convId */
export function useStreamingParts(convId: string | undefined): MessagePart[] | null {
  const [parts, setParts] = useState<MessagePart[] | null>(() =>
    convId ? getStreamParts(convId) : null,
  );
  useEffect(() => {
    if (!convId) {
      setParts(null);
      return;
    }
    // Re-read in case parts changed between render and effect
    setParts(getStreamParts(convId));
    return subscribeToStream(convId, setParts);
  }, [convId]);
  return parts;
}

export function useStreamingConvIds(): Set<string> {
  return useStreamingStore(useShallow((state) => state.streamingConvIds));
}

export function useIsStreaming(convId: string | undefined): boolean {
  return useStreamingStore((state) =>
    convId ? state.streamingConvIds.has(convId) : false,
  );
}
