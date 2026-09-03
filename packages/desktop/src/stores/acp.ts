import { create } from "zustand";
import type { AcpCapabilities, DbMessage } from "@thechat/shared";
import type { AcpEventState } from "../acp/event-reducer";

export interface AcpConversationRuntime {
  conversationId: string;
  profileId: string;
  cwd: string;
  generation: number;
  sessionId: string | null;
  profileFingerprint: string | null;
  capabilities: AcpCapabilities | null;
  eventState: AcpEventState;
}

export interface AcpTurnActivity {
  busy: boolean;
  completionVersion: number;
  lastMessage: DbMessage | null;
}

interface AcpStore {
  runtimes: Record<string, AcpConversationRuntime>;
  turnActivities: Record<string, AcpTurnActivity>;
  setRuntime: (runtime: AcpConversationRuntime) => void;
  updateEventState: (conversationId: string, eventState: AcpEventState) => void;
  dismissPermission: (conversationId: string, requestId: string) => void;
  clearRuntime: (conversationId: string) => void;
  setTurnBusy: (conversationId: string, busy: boolean) => void;
  completeTurn: (conversationId: string, message: DbMessage | null) => void;
  resetForTests: () => void;
}

export const useAcpStore = create<AcpStore>()((set) => ({
  runtimes: {},
  turnActivities: {},
  setRuntime: (runtime) =>
    set((state) => ({
      runtimes: { ...state.runtimes, [runtime.conversationId]: runtime },
    })),
  updateEventState: (conversationId, eventState) =>
    set((state) => {
      const runtime = state.runtimes[conversationId];
      if (!runtime || runtime.generation !== eventState.generation) return state;
      return {
        runtimes: {
          ...state.runtimes,
          [conversationId]: {
            ...runtime,
            capabilities: eventState.capabilities ?? runtime.capabilities,
            eventState,
          },
        },
      };
    }),
  dismissPermission: (conversationId, requestId) =>
    set((state) => {
      const runtime = state.runtimes[conversationId];
      if (!runtime) return state;
      const pendingPermissions = runtime.eventState.pendingPermissions.filter(
        (request) => request.id !== requestId,
      );
      if (
        pendingPermissions.length ===
        runtime.eventState.pendingPermissions.length
      ) {
        return state;
      }
      return {
        runtimes: {
          ...state.runtimes,
          [conversationId]: {
            ...runtime,
            eventState: { ...runtime.eventState, pendingPermissions },
          },
        },
      };
    }),
  clearRuntime: (conversationId) =>
    set((state) => {
      const { [conversationId]: _removedRuntime, ...runtimes } = state.runtimes;
      const { [conversationId]: _removedActivity, ...turnActivities } =
        state.turnActivities;
      return { runtimes, turnActivities };
    }),
  setTurnBusy: (conversationId, busy) =>
    set((state) => ({
      turnActivities: {
        ...state.turnActivities,
        [conversationId]: {
          busy,
          completionVersion:
            state.turnActivities[conversationId]?.completionVersion ?? 0,
          lastMessage: state.turnActivities[conversationId]?.lastMessage ?? null,
        },
      },
    })),
  completeTurn: (conversationId, message) =>
    set((state) => ({
      turnActivities: {
        ...state.turnActivities,
        [conversationId]: {
          busy: false,
          completionVersion:
            (state.turnActivities[conversationId]?.completionVersion ?? 0) + 1,
          lastMessage: message,
        },
      },
    })),
  resetForTests: () => set({ runtimes: {}, turnActivities: {} }),
}));
