import { create } from "zustand";
import { useShallow } from "zustand/shallow";
import type { MessagePart } from "../core/types";

interface StreamingStore {
  streams: Map<string, MessagePart[]>;
  streamingConvIds: Set<string>;

  startStreaming: (convId: string) => void;
  updateParts: (convId: string, parts: MessagePart[]) => void;
  stopStreaming: (convId: string) => void;
}

export const useStreamingStore = create<StreamingStore>((set) => ({
  streams: new Map(),
  streamingConvIds: new Set(),

  startStreaming: (convId) =>
    set((state) => {
      const streams = new Map(state.streams);
      streams.set(convId, []);
      const streamingConvIds = new Set(state.streamingConvIds);
      streamingConvIds.add(convId);
      return { streams, streamingConvIds };
    }),

  updateParts: (convId, parts) =>
    set((state) => {
      const streams = new Map(state.streams);
      streams.set(convId, parts);
      return { streams };
    }),

  stopStreaming: (convId) =>
    set((state) => {
      const streams = new Map(state.streams);
      streams.delete(convId);
      const streamingConvIds = new Set(state.streamingConvIds);
      streamingConvIds.delete(convId);
      return { streams, streamingConvIds };
    }),
}));

export function useStreamingParts(convId: string | undefined): MessagePart[] | null {
  return useStreamingStore(
    useShallow((state) => (convId ? state.streams.get(convId) ?? null : null)),
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
