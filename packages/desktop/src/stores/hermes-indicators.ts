import { create } from "zustand";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRuntimeSnapshot,
} from "@thechat/shared";
import {
  deriveApprovalStates,
  isApprovalRequestEvent,
  isApprovalResolutionEvent,
  type ApprovalDecision,
} from "../lib/hermes-approvals";

/**
 * Workspace-wide Hermes attention indicators, fed by the global WebSocket
 * handlers so they accrue even when the DM route is not mounted:
 *
 * - `pendingApprovals`: approval.request events that have not been resolved
 *   yet (by an approval.resolved event, a local decision, or the invocation
 *   finishing), oldest first.
 * - `unreadScopes`: task scopes (conversation + thread) whose invocation
 *   finished while the user was not viewing that scope. Cleared when the
 *   scope becomes visible.
 */

export interface HermesPendingApproval {
  eventId: string;
  invocationId: string;
  conversationId: string;
  threadId: string | null;
  botUserId: string | null;
  createdAt: string;
}

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
  pendingApprovals: HermesPendingApproval[];
  unreadScopes: Record<string, HermesUnreadScope>;
  invocationMeta: Record<string, InvocationMeta>;
  visibleScope: string | null;
  trackInvocation: (invocation: BotInvocationPublic) => void;
  trackProgressEvent: (event: BotInvocationProgressEventPublic) => void;
  markScopeUnread: (scope: HermesUnreadScope) => void;
  resolveApproval: (eventId: string) => void;
  seedFromSnapshot: (
    conversationId: string,
    snapshot: BotRuntimeSnapshot,
    localDecisions: Record<string, ApprovalDecision>,
  ) => void;
  setVisibleScope: (scopeKey: string | null) => void;
  resetForTests: () => void;
}

export function hermesScopeKey(conversationId: string, threadId: string | null) {
  return threadId ? `${conversationId}:thread:${threadId}` : `${conversationId}:general`;
}

const initialState = {
  pendingApprovals: [] as HermesPendingApproval[],
  unreadScopes: {} as Record<string, HermesUnreadScope>,
  invocationMeta: {} as Record<string, InvocationMeta>,
  visibleScope: null as string | null,
};

export const useHermesIndicatorsStore = create<HermesIndicatorsStore>()((set) => ({
  ...initialState,

  trackInvocation: (invocation) => {
    if (invocation.botKind !== "hermes") return;
    set((state) => {
      const isActive =
        invocation.status === "queued" || invocation.status === "running";
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

      // Terminal update: drop its pending approvals and, unless the user is
      // looking at this scope, mark it unread. Only an observed
      // active -> terminal transition counts — the server may re-publish
      // already-terminal invocations, which must not re-mark a read scope.
      const wasActive = !!state.invocationMeta[invocation.id];
      const next: Partial<HermesIndicatorsStore> = {};
      if (state.pendingApprovals.some((p) => p.invocationId === invocation.id)) {
        next.pendingApprovals = state.pendingApprovals.filter(
          (p) => p.invocationId !== invocation.id,
        );
      }
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

  trackProgressEvent: (event) => {
    if (isApprovalRequestEvent(event)) {
      set((state) => {
        if (state.pendingApprovals.some((p) => p.eventId === event.id)) return state;
        const meta = state.invocationMeta[event.invocationId];
        return {
          pendingApprovals: [
            ...state.pendingApprovals,
            {
              eventId: event.id,
              invocationId: event.invocationId,
              conversationId: event.conversationId,
              threadId: event.threadId ?? meta?.threadId ?? null,
              botUserId: meta?.botUserId ?? null,
              createdAt: event.createdAt,
            },
          ],
        };
      });
      return;
    }
    if (!isApprovalResolutionEvent(event)) return;
    set((state) => {
      // Mirror the gateway: resolutions apply to the invocation's pending
      // approvals oldest-first; resolveAll clears them all.
      const pending = state.pendingApprovals.filter(
        (p) => p.invocationId === event.invocationId,
      );
      if (pending.length === 0) return state;
      const resolveAll = event.payload?.resolveAll === true;
      const resolved = new Set(
        (resolveAll ? pending : pending.slice(0, 1)).map((p) => p.eventId),
      );
      return {
        pendingApprovals: state.pendingApprovals.filter(
          (p) => !resolved.has(p.eventId),
        ),
      };
    });
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

  resolveApproval: (eventId) => {
    set((state) => {
      if (!state.pendingApprovals.some((p) => p.eventId === eventId)) return state;
      return {
        pendingApprovals: state.pendingApprovals.filter(
          (p) => p.eventId !== eventId,
        ),
      };
    });
  },

  seedFromSnapshot: (conversationId, snapshot, localDecisions) => {
    set((state) => {
      const activeInvocations = snapshot.invocations.filter(
        (invocation) =>
          invocation.botKind === "hermes" &&
          (invocation.status === "queued" || invocation.status === "running"),
      );
      const invocationMeta = { ...state.invocationMeta };
      for (const invocation of activeInvocations) {
        invocationMeta[invocation.id] = {
          conversationId: invocation.conversationId,
          threadId: invocation.threadId,
          botUserId: invocation.botUserId,
        };
      }

      const pending: HermesPendingApproval[] = [];
      for (const invocation of activeInvocations) {
        const events = snapshot.events.filter(
          (event) => event.invocationId === invocation.id,
        );
        for (const approval of deriveApprovalStates(events, localDecisions)) {
          if (approval.status !== "pending") continue;
          pending.push({
            eventId: approval.event.id,
            invocationId: invocation.id,
            conversationId,
            threadId: approval.event.threadId ?? invocation.threadId,
            botUserId: invocation.botUserId,
            createdAt: approval.event.createdAt,
          });
        }
      }
      pending.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

      return {
        invocationMeta,
        pendingApprovals: [
          ...state.pendingApprovals.filter(
            (p) => p.conversationId !== conversationId,
          ),
          ...pending,
        ],
      };
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

/** Resolve a pending approval without subscribing — for event handlers. */
export function resolveHermesApprovalIndicator(eventId: string) {
  useHermesIndicatorsStore.getState().resolveApproval(eventId);
}
