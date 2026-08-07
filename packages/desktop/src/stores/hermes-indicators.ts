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
import {
  deriveClarifyStates,
  isClarifyRequestEvent,
  isClarifyResolutionEvent,
} from "../lib/hermes-clarifications";
import { isTerminalHermesProgressEvent } from "../lib/bot-runtime-state";

/**
 * Workspace-wide Hermes attention indicators, fed by the global WebSocket
 * handlers so they accrue even when the DM route is not mounted:
 *
 * - `pendingApprovals`: approval.request events that have not been resolved
 *   yet (by an approval.resolved event, a local decision, or the invocation
 *   finishing), oldest first.
 * - `pendingClarifications`: clarify.request events awaiting an exact
 *   clarify.resolved transition, tracked even when another DM/thread is open.
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
  requestId: string | null;
  sessionKey: string | null;
}

export type HermesPendingClarification = HermesPendingApproval;

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
  pendingClarifications: HermesPendingClarification[];
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
  pendingApprovals: [] as HermesPendingApproval[],
  pendingClarifications: [] as HermesPendingClarification[],
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

      // Legacy terminal update: drop its pending approvals and, unless the user is
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
      if (
        state.pendingClarifications.some(
          (clarify) => clarify.invocationId === invocation.id,
        )
      ) {
        next.pendingClarifications = state.pendingClarifications.filter(
          (clarify) => clarify.invocationId !== invocation.id,
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
        const pendingApprovals = state.pendingApprovals.filter(
          (approval) => approval.invocationId !== event.invocationId,
        );
        const pendingClarifications = state.pendingClarifications.filter(
          (clarify) => clarify.invocationId !== event.invocationId,
        );
        const next: Partial<HermesIndicatorsStore> = {
          invocationMeta,
          pendingApprovals,
          pendingClarifications,
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

    if (invocation?.botKind === "hermes") {
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
              requestId: payloadString(event, "requestId"),
              sessionKey: payloadString(event, "sessionKey"),
            },
          ],
        };
      });
      return;
    }
    if (isApprovalResolutionEvent(event)) {
      set((state) => {
        // Mirror the gateway: resolutions apply to the invocation's pending
        // approvals oldest-first; resolveAll clears them all.
        const invocationPending = state.pendingApprovals.filter(
          (p) => p.invocationId === event.invocationId,
        );
        if (invocationPending.length === 0) return state;
        const requestId = payloadString(event, "requestId");
        const sessionKey = payloadString(event, "sessionKey");
        const pending = requestId
          ? invocationPending.filter(
              (approval) => approval.requestId === requestId,
            )
          : invocationPending.filter(
              (approval) => !sessionKey || approval.sessionKey === sessionKey,
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
      return;
    }

    if (isClarifyRequestEvent(event)) {
      set((state) => {
        if (state.pendingClarifications.some((item) => item.eventId === event.id)) {
          return state;
        }
        const meta = state.invocationMeta[event.invocationId];
        return {
          pendingClarifications: [
            ...state.pendingClarifications,
            {
              eventId: event.id,
              invocationId: event.invocationId,
              conversationId: event.conversationId,
              threadId: event.threadId ?? meta?.threadId ?? null,
              botUserId: meta?.botUserId ?? null,
              createdAt: event.createdAt,
              requestId: payloadString(event, "requestId"),
              sessionKey: payloadString(event, "sessionKey"),
            },
          ],
        };
      });
      return;
    }
    if (!isClarifyResolutionEvent(event)) return;
    set((state) => {
      const invocationPending = state.pendingClarifications.filter(
        (clarify) => clarify.invocationId === event.invocationId,
      );
      if (invocationPending.length === 0) return state;
      const requestId = payloadString(event, "requestId");
      const sessionKey = payloadString(event, "sessionKey");
      const target = requestId
        ? invocationPending.find((clarify) => clarify.requestId === requestId)
        : invocationPending.find(
            (clarify) => !sessionKey || clarify.sessionKey === sessionKey,
          );
      if (!target) return state;
      return {
        pendingClarifications: state.pendingClarifications.filter(
          (clarify) => clarify.eventId !== target.eventId,
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
        (invocation) => {
          if (
            invocation.botKind !== "hermes" ||
            invocation.status === "completed" ||
            invocation.status === "failed" ||
            invocation.status === "cancelled"
          ) {
            return false;
          }
          return (
            invocation.status === "queued" ||
            snapshot.events.some((event) => event.invocationId === invocation.id)
          );
        },
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
      const pendingClarifications: HermesPendingClarification[] = [];
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
            requestId: payloadString(approval.event, "requestId"),
            sessionKey: payloadString(approval.event, "sessionKey"),
          });
        }
        for (const clarify of deriveClarifyStates(events, {})) {
          if (clarify.status !== "pending") continue;
          pendingClarifications.push({
            eventId: clarify.event.id,
            invocationId: invocation.id,
            conversationId,
            threadId: clarify.event.threadId ?? invocation.threadId,
            botUserId: invocation.botUserId,
            createdAt: clarify.event.createdAt,
            requestId: payloadString(clarify.event, "requestId"),
            sessionKey: payloadString(clarify.event, "sessionKey"),
          });
        }
      }
      pending.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      pendingClarifications.sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
      );

      return {
        invocationMeta,
        pendingApprovals: [
          ...state.pendingApprovals.filter(
            (p) => p.conversationId !== conversationId,
          ),
          ...pending,
        ],
        pendingClarifications: [
          ...state.pendingClarifications.filter(
            (clarify) => clarify.conversationId !== conversationId,
          ),
          ...pendingClarifications,
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

function payloadString(
  event: BotInvocationProgressEventPublic,
  key: string,
) {
  const value = event.payload?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
