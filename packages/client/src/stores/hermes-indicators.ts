import { onSessionReset } from "../lib/session-boundary";
import { create } from "zustand";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
} from "@thechat/shared";
import { isTerminalHermesProgressEvent } from "../lib/bot-runtime-state";

/**
 * Workspace-wide Hermes attention indicators, fed by the global WebSocket
 * handlers so they accrue even when the DM route is not mounted:
 *
 * - `unreadScopes`: task scopes (conversation + thread) whose invocation
 *   finished while the user was not viewing that scope. Cleared when the
 *   scope becomes visible.
 *
 * Approvals and questions are bot requests: the bot-requests store holds
 * them from PostgreSQL rows, so nothing here derives them from progress.
 */

export interface HermesUnreadScope {
  conversationId: string;
  threadId: string | null;
  botUserId: string | null;
}

interface InvocationMeta {
  conversationId: string;
  threadId: string | null;
  botUserId: string;
}

interface HermesIndicatorsStore {
  unreadScopes: Record<string, HermesUnreadScope>;
  invocationMeta: Record<string, InvocationMeta>;
  terminalSequences: Record<string, number>;
  visibleScope: string | null;
  trackInvocation: (invocation: BotInvocationPublic) => void;
  trackProgressEvent: (
    event: BotInvocationProgressEventPublic,
    invocation?: BotInvocationPublic,
  ) => void;
  markScopeUnread: (scope: HermesUnreadScope) => void;
  /** Remember runs that were active before this client connected. */
  seedFromSnapshot: (snapshot: BotRuntimeSnapshot) => void;
  setVisibleScope: (scopeKey: string | null) => void;
  resetForTests: () => void;
}

export function hermesScopeKey(conversationId: string, threadId: string | null) {
  return threadId ? `${conversationId}:thread:${threadId}` : `${conversationId}:general`;
}

function hasHermesExecutionCompletion(
  responseJson: BotInvocationPublic["responseJson"],
) {
  if (!responseJson) return false;
  return responseJson.silent === true ||
    (typeof responseJson.completion === "object" && responseJson.completion !== null);
}

function rememberTerminalSequence(
  existing: Record<string, number>,
  invocationId: string,
  sequence: number,
) {
  const nextSequence = Math.max(existing[invocationId] ?? 0, sequence);
  const next = { ...existing, [invocationId]: nextSequence };
  const keys = Object.keys(next);
  if (keys.length > 500) delete next[keys[0]!];
  return next;
}

const initialState = {
  unreadScopes: {} as Record<string, HermesUnreadScope>,
  invocationMeta: {} as Record<string, InvocationMeta>,
  terminalSequences: {} as Record<string, number>,
  visibleScope: null as string | null,
};

export const useHermesIndicatorsStore = create<HermesIndicatorsStore>()((set, get) => ({
  ...initialState,

  trackInvocation: (invocation) => {
    if (invocation.botKind !== "hermes") return;
    set((state) => {
      const isActive = invocation.status === "queued";
      if (isActive) {
        const existing = state.invocationMeta[invocation.id];
        if (
          existing &&
          existing.threadId === invocation.threadId &&
          existing.conversationId === invocation.conversationId
        ) {
          return state;
        }
        return {
          invocationMeta: {
            ...state.invocationMeta,
            [invocation.id]: {
              conversationId: invocation.conversationId,
              threadId: invocation.threadId,
              botUserId: invocation.botUserId,
            },
          },
        };
      }

      if (
        invocation.status !== "completed" &&
        invocation.status !== "failed" &&
        invocation.status !== "cancelled"
      ) {
        if (
          invocation.status === "claimed" &&
          hasHermesExecutionCompletion(invocation.responseJson)
        ) {
          // Terminal Hermes callbacks keep delivery status `claimed`; retain
          // progress metadata until the terminal progress event consumes it.
          return state;
        }
        const invocationMeta = { ...state.invocationMeta };
        delete invocationMeta[invocation.id];
        return { invocationMeta };
      }

      // Legacy terminal update: unless the user is looking at this scope,
      // mark it unread. Only an observed active -> terminal transition
      // counts — the server may re-publish already-terminal invocations,
      // which must not re-mark a read scope.
      const wasActive = !!state.invocationMeta[invocation.id];
      const next: Partial<HermesIndicatorsStore> = {};
      if (wasActive) {
        const meta = { ...state.invocationMeta };
        delete meta[invocation.id];
        next.invocationMeta = meta;
      }
      const finished =
        invocation.status === "completed" || invocation.status === "failed";
      const scopeKey = hermesScopeKey(invocation.conversationId, invocation.threadId);
      if (wasActive && finished && scopeKey !== state.visibleScope && !state.unreadScopes[scopeKey]) {
        next.unreadScopes = {
          ...state.unreadScopes,
          [scopeKey]: {
            conversationId: invocation.conversationId,
            threadId: invocation.threadId,
            botUserId: invocation.botUserId,
          },
        };
      }
      return Object.keys(next).length > 0 ? next : state;
    });
  },

  trackProgressEvent: (event, invocation) => {
    const terminalSequence = get().terminalSequences[event.invocationId];
    if (
      !isTerminalHermesProgressEvent(event) &&
      terminalSequence !== undefined &&
      terminalSequence >= event.sequence
    ) {
      return;
    }
    if (isTerminalHermesProgressEvent(event)) {
      set((state) => {
        const wasActive = !!state.invocationMeta[event.invocationId];
        const meta = state.invocationMeta[event.invocationId] ??
          (invocation?.botKind === "hermes"
            ? {
                conversationId: invocation.conversationId,
                threadId: invocation.threadId,
                botUserId: invocation.botUserId,
              }
            : null);
        const invocationMeta = { ...state.invocationMeta };
        delete invocationMeta[event.invocationId];
        const next: Partial<HermesIndicatorsStore> = {
          invocationMeta,
          terminalSequences: rememberTerminalSequence(
            state.terminalSequences,
            event.invocationId,
            event.sequence,
          ),
        };
        const finished =
          event.type === "invocation.completed" || event.type === "invocation.failed";
        const conversationId = meta?.conversationId ?? event.conversationId;
        const threadId = meta?.threadId ?? event.threadId ?? null;
        const scopeKey = hermesScopeKey(conversationId, threadId);
        if (
          wasActive &&
          finished &&
          scopeKey !== state.visibleScope &&
          !state.unreadScopes[scopeKey]
        ) {
          next.unreadScopes = {
            ...state.unreadScopes,
            [scopeKey]: {
              conversationId,
              threadId,
              botUserId: meta?.botUserId ?? invocation?.botUserId ?? null,
            },
          };
        }
        return next;
      });
      return;
    }

    if (invocation?.botKind === "hermes" && !get().invocationMeta[event.invocationId]) {
      set((state) => ({
        invocationMeta: {
          ...state.invocationMeta,
          [event.invocationId]: {
            conversationId: invocation.conversationId,
            threadId: invocation.threadId,
            botUserId: invocation.botUserId,
          },
        },
      }));
    }
  },

  markScopeUnread: (scope) => {
    set((state) => {
      const scopeKey = hermesScopeKey(scope.conversationId, scope.threadId);
      if (scopeKey === state.visibleScope || state.unreadScopes[scopeKey]) {
        return state;
      }
      return {
        unreadScopes: {
          ...state.unreadScopes,
          [scopeKey]: scope,
        },
      };
    });
  },

  seedFromSnapshot: (snapshot) => {
    set((state) => {
      let invocationMeta: Record<string, InvocationMeta> | null = null;
      for (const invocation of snapshot.invocations) {
        if (
          invocation.botKind !== "hermes" ||
          invocation.status === "completed" ||
          invocation.status === "failed" ||
          invocation.status === "cancelled"
        ) {
          continue;
        }
        const active =
          invocation.status === "queued" ||
          snapshot.events.some((event) => event.invocationId === invocation.id);
        if (!active || state.invocationMeta[invocation.id]) continue;
        invocationMeta ??= { ...state.invocationMeta };
        invocationMeta[invocation.id] = {
          conversationId: invocation.conversationId,
          threadId: invocation.threadId,
          botUserId: invocation.botUserId,
        };
      }
      return invocationMeta ? { invocationMeta } : state;
    });
  },

  setVisibleScope: (scopeKey) => {
    set((state) => {
      if (scopeKey === null) {
        return state.visibleScope === null ? state : { visibleScope: null };
      }
      if (state.visibleScope === scopeKey && !state.unreadScopes[scopeKey]) {
        return state;
      }
      const next: Partial<HermesIndicatorsStore> = { visibleScope: scopeKey };
      if (state.unreadScopes[scopeKey]) {
        const unreadScopes = { ...state.unreadScopes };
        delete unreadScopes[scopeKey];
        next.unreadScopes = unreadScopes;
      }
      return next;
    });
  },

  resetForTests: () => set({ ...initialState }),
}));

onSessionReset(() => useHermesIndicatorsStore.setState(useHermesIndicatorsStore.getInitialState()));
