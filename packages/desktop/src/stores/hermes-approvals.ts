import { create } from "zustand";
import type { ApprovalDecision } from "../lib/hermes-approvals";
import { resolveHermesApprovalIndicator } from "./hermes-indicators";

/**
 * Approval decisions the user already sent from this client, keyed by the
 * approval.request progress event id. Lives outside React so the optimistic
 * "resolved" state survives chat view remounts (thread switches, history
 * unloads) — otherwise an already-answered approval card would come back with
 * active buttons. Entries are pruned FIFO; progress events themselves expire
 * server-side, so stale ids are harmless.
 */
const MAX_TRACKED_DECISIONS = 200;

interface HermesApprovalsStore {
  decisions: Record<string, ApprovalDecision>;
  decisionOrder: string[];
  recordDecision: (eventId: string, decision: ApprovalDecision) => void;
  resetForTests: () => void;
}

export const useHermesApprovalsStore = create<HermesApprovalsStore>()((set) => ({
  decisions: {},
  decisionOrder: [],

  recordDecision: (eventId, decision) => {
    set((state) => {
      if (state.decisions[eventId] === decision) return state;
      const order = [
        ...state.decisionOrder.filter((id) => id !== eventId),
        eventId,
      ];
      const decisions = { ...state.decisions, [eventId]: decision };
      while (order.length > MAX_TRACKED_DECISIONS) {
        delete decisions[order.shift()!];
      }
      return { decisions, decisionOrder: order };
    });
  },

  resetForTests: () => set({ decisions: {}, decisionOrder: [] }),
}));

/** Record a decision without subscribing — for event handlers outside render. */
export function recordApprovalDecision(
  eventId: string,
  decision: ApprovalDecision,
) {
  useHermesApprovalsStore.getState().recordDecision(eventId, decision);
  resolveHermesApprovalIndicator(eventId);
}
