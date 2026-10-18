import { createContext, useContext } from "react";
import { create } from "zustand";
import type {
  BotRequestAnswer,
  BotRequestInbox,
  BotRequestPublic,
} from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";
import { isAuthenticated } from "../lib/auth-identity";
import { onSessionReset } from "../lib/session-boundary";
import { useAuthStore } from "./auth";

/**
 * Client mirror of PostgreSQL bot requests. Rows arrive from three places:
 * the inbox fetch, per-conversation fetches, and `bot_request_updated` pushes.
 * The row with the newest `updatedAt` wins, so a late or replayed push never
 * reopens a resolved card.
 */
interface BotRequestsState {
  byId: Record<string, BotRequestPublic>;
  /** Ids returned by the last inbox fetch for recently resolved requests. */
  recentIds: string[];
  inboxLoaded: boolean;
  inboxLoading: boolean;
  inboxError: string | null;
  loadedConversations: Record<string, true>;
  upsert: (request: BotRequestPublic) => void;
  upsertMany: (requests: BotRequestPublic[]) => void;
  fetchInbox: () => Promise<void>;
  fetchConversation: (conversationId: string) => Promise<void>;
  answer: (requestId: string, answer: BotRequestAnswer) => Promise<BotRequestPublic>;
  reset: () => void;
}

const initialState = {
  byId: {} as Record<string, BotRequestPublic>,
  recentIds: [] as string[],
  inboxLoaded: false,
  inboxLoading: false,
  inboxError: null as string | null,
  loadedConversations: {} as Record<string, true>,
};

export class BotRequestAnswerError extends Error {
  constructor(message: string, public readonly request: BotRequestPublic | null) {
    super(message);
    this.name = "BotRequestAnswerError";
  }
}

function newer(existing: BotRequestPublic | undefined, incoming: BotRequestPublic) {
  if (!existing) return true;
  const delta = Date.parse(incoming.updatedAt) - Date.parse(existing.updatedAt);
  if (delta !== 0) return delta > 0;
  // Same timestamp: never move backwards from a terminal status.
  return existing.status === "open" || incoming.status !== "open";
}

function mergeRows(
  byId: Record<string, BotRequestPublic>,
  requests: BotRequestPublic[],
) {
  let next: Record<string, BotRequestPublic> | null = null;
  for (const request of requests) {
    const current = (next ?? byId)[request.id];
    if (!newer(current, request)) continue;
    next ??= { ...byId };
    next[request.id] = request;
  }
  return next;
}

export const useBotRequestsStore = create<BotRequestsState>()((set, get) => ({
  ...initialState,

  upsert: (request) => get().upsertMany([request]),

  upsertMany: (requests) => {
    set((state) => {
      const byId = mergeRows(state.byId, requests);
      return byId ? { byId } : state;
    });
  },

  fetchInbox: async () => {
    const token = useAuthStore.getState().token;
    if (!isAuthenticated(token)) return;
    set({ inboxLoading: true, inboxError: null });
    try {
      const { data, error } = await api.inbox.get(authHeaders(token));
      if (error) throw new Error(edenErrorMessage(error, "Failed to load the inbox"));
      const inbox = data as BotRequestInbox;
      // Requests that left the open list while we were offline are stale in
      // the local map; drop open rows the server no longer reports.
      set((state) => {
        const openIds = new Set(inbox.open.map((request) => request.id));
        const byId = { ...state.byId };
        for (const [id, request] of Object.entries(byId)) {
          if (request.status === "open" && !openIds.has(id)) delete byId[id];
        }
        return {
          byId: mergeRows(byId, [...inbox.open, ...inbox.recent]) ?? byId,
          recentIds: inbox.recent.map((request) => request.id),
          inboxLoaded: true,
        };
      });
    } catch (error) {
      set({
        inboxError: error instanceof Error ? error.message : "Failed to load the inbox",
      });
    } finally {
      set({ inboxLoading: false });
    }
  },

  fetchConversation: async (conversationId) => {
    const token = useAuthStore.getState().token;
    if (!isAuthenticated(token)) return;
    const { data, error } = await api["bot-requests"]
      .conversations({ conversationId })
      .get(authHeaders(token));
    if (error || !data || !("requests" in data)) return;
    const requests = data.requests as BotRequestPublic[];
    set((state) => {
      const byId = { ...state.byId };
      const returnedIds = new Set(requests.map((request) => request.id));
      // Open rows for this conversation that the server no longer returns
      // were resolved while we were away and fell out of the window.
      for (const [id, request] of Object.entries(byId)) {
        if (request.conversationId === conversationId && !returnedIds.has(id)) {
          if (request.status === "open") delete byId[id];
        }
      }
      return {
        byId: mergeRows(byId, requests) ?? byId,
        loadedConversations: { ...state.loadedConversations, [conversationId]: true },
      };
    });
  },

  answer: async (requestId, answer) => {
    const token = useAuthStore.getState().token;
    if (!isAuthenticated(token)) throw new BotRequestAnswerError("Sign in to answer", null);
    const { data, error } = await api["bot-requests"]({ requestId })
      .answer.post(answer, authHeaders(token));
    if (error) {
      const value = (error as { value?: unknown }).value;
      const current =
        value && typeof value === "object" && "request" in value
          ? ((value as { request?: BotRequestPublic }).request ?? null)
          : null;
      if (current) get().upsert(current);
      throw new BotRequestAnswerError(
        edenErrorMessage(error, "Could not send the answer"),
        current,
      );
    }
    const request = (data as { request: BotRequestPublic }).request;
    get().upsert(request);
    return request;
  },

  reset: () => set({ ...initialState }),
}));

/**
 * How request cards submit answers. Views use the API through the store; the
 * /hermes-debug harness swaps in a local answerer and skips server syncing.
 */
export interface BotRequestAnswerer {
  answer: (requestId: string, answer: BotRequestAnswer) => Promise<BotRequestPublic>;
  local?: boolean;
}

export const BotRequestAnswererContext = createContext<BotRequestAnswerer | null>(null);

export function useBotRequestAnswerer(): BotRequestAnswerer {
  const override = useContext(BotRequestAnswererContext);
  const answer = useBotRequestsStore((state) => state.answer);
  return override ?? { answer };
}

export function useConversationBotRequests(conversationId: string | null) {
  return useBotRequestsStore((state) =>
    conversationId ? selectConversationRequests(state.byId, conversationId) : EMPTY,
  );
}

const EMPTY: BotRequestPublic[] = [];
const conversationCache = new WeakMap<
  Record<string, BotRequestPublic>,
  Map<string, BotRequestPublic[]>
>();

/** Memoized per `byId` snapshot so selectors return stable arrays. */
export function selectConversationRequests(
  byId: Record<string, BotRequestPublic>,
  conversationId: string,
) {
  let perConversation = conversationCache.get(byId);
  if (!perConversation) {
    perConversation = new Map();
    conversationCache.set(byId, perConversation);
  }
  const cached = perConversation.get(conversationId);
  if (cached) return cached;
  const rows = Object.values(byId)
    .filter((request) => request.conversationId === conversationId)
    .sort(compareRequests);
  perConversation.set(conversationId, rows);
  return rows;
}

const openCache = new WeakMap<Record<string, BotRequestPublic>, BotRequestPublic[]>();

/** Open requests the signed-in user may answer, oldest first. */
export function selectOpenRequests(
  byId: Record<string, BotRequestPublic>,
  userId: string | null,
) {
  const cached = openCache.get(byId);
  const all =
    cached ??
    Object.values(byId)
      .filter((request) => request.status === "open")
      .sort(compareRequests);
  if (!cached) openCache.set(byId, all);
  if (!userId) return all;
  return all.filter(
    (request) => !request.audienceUserId || request.audienceUserId === userId,
  );
}

export function useOpenBotRequests() {
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const byId = useBotRequestsStore((state) => state.byId);
  return selectOpenRequests(byId, userId);
}

export function compareRequests(left: BotRequestPublic, right: BotRequestPublic) {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * The earliest open request in each order group is actionable; later ones
 * wait, mirroring the server's oldest-first rule.
 */
export function blockedRequestIds(requests: BotRequestPublic[]) {
  const seenGroups = new Set<string>();
  const blocked = new Set<string>();
  for (const request of [...requests].sort(compareRequests)) {
    if (request.status !== "open" || !request.orderGroup) continue;
    const key = `${request.botId}\0${request.kind}\0${request.orderGroup}`;
    if (seenGroups.has(key)) blocked.add(request.id);
    else seenGroups.add(key);
  }
  return blocked;
}

onSessionReset(() => useBotRequestsStore.getState().reset());
