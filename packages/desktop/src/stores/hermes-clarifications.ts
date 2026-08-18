import { create } from "zustand";
import type { ClarifyResponse } from "../lib/hermes-clarifications";

const MAX_TRACKED_RESPONSES = 200;

interface HermesClarificationsStore {
  responses: Record<string, ClarifyResponse>;
  responseOrder: string[];
  recordResponse: (eventId: string, response: ClarifyResponse) => void;
  resetForTests: () => void;
}

export const useHermesClarificationsStore =
  create<HermesClarificationsStore>()((set) => ({
    responses: {},
    responseOrder: [],

    recordResponse: (eventId, response) => {
      set((state) => {
        const responseOrder = [
          ...state.responseOrder.filter((id) => id !== eventId),
          eventId,
        ];
        const responses = { ...state.responses, [eventId]: response };
        while (responseOrder.length > MAX_TRACKED_RESPONSES) {
          delete responses[responseOrder.shift()!];
        }
        return { responses, responseOrder };
      });
    },

    resetForTests: () => set({ responses: {}, responseOrder: [] }),
  }));

export function recordClarifyResponse(
  eventId: string,
  response: ClarifyResponse,
) {
  useHermesClarificationsStore.getState().recordResponse(eventId, response);
}
