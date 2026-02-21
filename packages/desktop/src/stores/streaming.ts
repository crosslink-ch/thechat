import { create } from "zustand";
import { useShallow } from "zustand/shallow";
import type { MessagePart } from "../core/types";

interface StreamingStore {
  streams: Record<string, MessagePart[]>;
  streamingConvIds: Set<string>;

  startStreaming: (convId: string) => void;
  updateParts: (convId: string, parts: MessagePart[]) => void;
  stopStreaming: (convId: string) => void;
}

export const useStreamingStore = create<StreamingStore>((set) => ({
  streams: {},
  streamingConvIds: new Set(),

  startStreaming: (convId) =>
    set((state) => {
      const streamingConvIds = new Set(state.streamingConvIds);
      streamingConvIds.add(convId);
      return { streams: { ...state.streams, [convId]: [] }, streamingConvIds };
    }),

  updateParts: (convId, parts) =>
    set((state) => ({
      streams: { ...state.streams, [convId]: parts },
    })),

  stopStreaming: (convId) =>
    set((state) => {
      const { [convId]: _, ...rest } = state.streams;
      const streamingConvIds = new Set(state.streamingConvIds);
      streamingConvIds.delete(convId);
      return { streams: rest, streamingConvIds };
    }),
}));

export function useStreamingParts(convId: string | undefined): MessagePart[] | null {
  return useStreamingStore(
    useShallow((state) => (convId ? state.streams[convId] ?? null : null)),
  );
}

export function useStreamingConvIds(): Set<string> {
  return useStreamingStore(useShallow((state) => state.streamingConvIds));
}

export function useIsStreaming(convId: string | undefined): boolean {
  return useStreamingStore((state) =>
    convId ? state.streamingConvIds.has(convId) : false,
  );
}
