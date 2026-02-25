import { useState, useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/shallow";
import type { MessagePart } from "../core/types";

// --- Plain JS layer (no React involvement) ---

// Accumulated parts per conversation — plain JS Map, not in Zustand
const accumulatedParts = new Map<string, MessagePart[]>();
const listeners = new Map<string, Set<(parts: MessagePart[]) => void>>();

/** Called from useChat onEvent — updates the Map + notifies active listeners */
export function updateStreamParts(convId: string, parts: MessagePart[]) {
  accumulatedParts.set(convId, parts);
  const subs = listeners.get(convId);
  if (subs) {
    for (const fn of subs) fn(parts);
  }
}

export function getStreamParts(convId: string): MessagePart[] | null {
  return accumulatedParts.get(convId) ?? null;
}

export function subscribeToStream(
  convId: string,
  listener: (parts: MessagePart[]) => void,
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
    set((state) => {
      const streamingConvIds = new Set(state.streamingConvIds);
      streamingConvIds.add(convId);
      return { streamingConvIds };
    });
  },

  stopStreaming: (convId) => {
    accumulatedParts.delete(convId);
    listeners.delete(convId);
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
