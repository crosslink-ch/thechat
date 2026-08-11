import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export interface NeedsAttentionScope {
  conversationId: string;
  threadId: string | null;
  workspaceId?: string;
  directUserId?: string;
}

interface PersistedNeedsAttention {
  version: 1;
  scopes: NeedsAttentionScope[];
}

interface NeedsAttentionStore {
  activeUserId: string | null;
  initialized: boolean;
  scopes: Record<string, NeedsAttentionScope>;
  error: string | null;
  revision: number;
  initialize: (userId: string | null) => Promise<void>;
  toggle: (scope: NeedsAttentionScope) => Promise<boolean>;
  resetForTests: () => void;
}

const KV_PREFIX = "needs_attention_v1:";
const MAX_PERSISTENCE_ATTEMPTS = 8;
let initializationGeneration = 0;
let persistenceQueue: Promise<void> = Promise.resolve();
const persistedScopesByUserId = new Map<
  string,
  Record<string, NeedsAttentionScope>
>();

export function needsAttentionKvKey(userId: string) {
  return `${KV_PREFIX}${userId}`;
}

export function needsAttentionScopeKey(
  conversationId: string,
  threadId: string | null = null,
) {
  return JSON.stringify([conversationId, threadId]);
}

export function scopeNeedsAttention(
  scopes: Record<string, NeedsAttentionScope>,
  conversationId: string,
  threadId: string | null = null,
) {
  return Boolean(scopes[needsAttentionScopeKey(conversationId, threadId)]);
}

export function conversationNeedsAttention(
  scopes: Record<string, NeedsAttentionScope>,
  conversationId: string,
) {
  return Object.values(scopes).some(
    (scope) => scope.conversationId === conversationId,
  );
}

export function directMemberNeedsAttention(
  scopes: Record<string, NeedsAttentionScope>,
  workspaceId: string,
  directUserId: string,
) {
  return Object.values(scopes).some(
    (scope) =>
      scope.workspaceId === workspaceId && scope.directUserId === directUserId,
  );
}

export function attentionThreadIds(
  scopes: Record<string, NeedsAttentionScope>,
  conversationId: string,
) {
  const threadIds = new Set<string>();
  for (const scope of Object.values(scopes)) {
    if (scope.conversationId === conversationId && scope.threadId) {
      threadIds.add(scope.threadId);
    }
  }
  return threadIds;
}

function parsePersistedScopes(value: string | null) {
  const scopes: Record<string, NeedsAttentionScope> = {};
  if (!value) return scopes;

  try {
    const parsed = JSON.parse(value) as Partial<PersistedNeedsAttention>;
    if (parsed.version !== 1 || !Array.isArray(parsed.scopes)) return scopes;

    for (const candidate of parsed.scopes) {
      if (
        !candidate ||
        typeof candidate.conversationId !== "string" ||
        (candidate.threadId !== null && typeof candidate.threadId !== "string")
      ) {
        continue;
      }
      const conversationId = candidate.conversationId.trim();
      const threadId = candidate.threadId?.trim() || null;
      if (!conversationId) continue;
      const workspaceId =
        typeof candidate.workspaceId === "string"
          ? candidate.workspaceId.trim()
          : undefined;
      const directUserId =
        typeof candidate.directUserId === "string"
          ? candidate.directUserId.trim()
          : undefined;
      const scope: NeedsAttentionScope = { conversationId, threadId };
      if (workspaceId && directUserId) {
        scope.workspaceId = workspaceId;
        scope.directUserId = directUserId;
      }
      scopes[needsAttentionScopeKey(conversationId, threadId)] = scope;
    }
  } catch {
    // Corrupt local state should not prevent the desktop from starting.
  }

  return scopes;
}

function serializedScopes(scopes: Record<string, NeedsAttentionScope>) {
  const ordered = Object.values(scopes).sort((a, b) =>
    needsAttentionScopeKey(a.conversationId, a.threadId).localeCompare(
      needsAttentionScopeKey(b.conversationId, b.threadId),
    ),
  );
  return JSON.stringify({ version: 1, scopes: ordered } satisfies PersistedNeedsAttention);
}

function enqueuePersistence(operation: () => Promise<void>) {
  const result = persistenceQueue.then(operation, operation);
  persistenceQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function persistScopeMutation(
  userId: string,
  scopeKey: string,
  scope: NeedsAttentionScope | null,
) {
  const key = needsAttentionKvKey(userId);
  for (let attempt = 0; attempt < MAX_PERSISTENCE_ATTEMPTS; attempt += 1) {
    const expectedValue = await invoke<string | null>("kv_get", { key });
    const scopes = parsePersistedScopes(expectedValue);
    if (scope) scopes[scopeKey] = scope;
    else delete scopes[scopeKey];

    const value =
      Object.keys(scopes).length === 0 ? null : serializedScopes(scopes);
    const updated = await invoke<boolean>("kv_compare_and_set", {
      key,
      expectedValue,
      value,
    });
    if (updated) return scopes;
  }

  throw new Error("Needs attention state changed too frequently; try again");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const useNeedsAttentionStore = create<NeedsAttentionStore>()((set, get) => ({
  activeUserId: null,
  initialized: false,
  scopes: {},
  error: null,
  revision: 0,

  initialize: async (userId) => {
    const generation = ++initializationGeneration;
    if (!userId) {
      set({
        activeUserId: null,
        initialized: false,
        scopes: {},
        error: null,
        revision: 0,
      });
      return;
    }

    set({
      activeUserId: userId,
      initialized: false,
      scopes: {},
      error: null,
      revision: 0,
    });

    await persistenceQueue;
    try {
      const value = await invoke<string | null>("kv_get", {
        key: needsAttentionKvKey(userId),
      });
      if (
        generation !== initializationGeneration ||
        get().activeUserId !== userId
      ) {
        return;
      }
      const scopes = parsePersistedScopes(value);
      persistedScopesByUserId.set(userId, scopes);
      set({ scopes, initialized: true, error: null });
    } catch (error) {
      if (
        generation !== initializationGeneration ||
        get().activeUserId !== userId
      ) {
        return;
      }
      set({ scopes: {}, initialized: false, error: errorMessage(error) });
    }
  },

  toggle: async (scope) => {
    const state = get();
    const userId = state.activeUserId;
    if (!userId || !state.initialized) return false;

    const key = needsAttentionScopeKey(scope.conversationId, scope.threadId);
    const previousScopes = state.scopes;
    const nextScopes = { ...previousScopes };
    const needsAttention = !nextScopes[key];
    if (needsAttention) nextScopes[key] = scope;
    else delete nextScopes[key];

    const revision = state.revision + 1;
    set({ scopes: nextScopes, revision, error: null });

    try {
      await enqueuePersistence(async () => {
        const persistedScopes = await persistScopeMutation(
          userId,
          key,
          needsAttention ? scope : null,
        );
        persistedScopesByUserId.set(userId, persistedScopes);
        const latest = get();
        if (latest.activeUserId === userId && latest.revision === revision) {
          set({ scopes: persistedScopes });
        }
      });
      return needsAttention;
    } catch (error) {
      const latest = get();
      const persistedScopes = persistedScopesByUserId.get(userId) ?? {};
      if (latest.activeUserId === userId && latest.revision === revision) {
        set({
          scopes: persistedScopes,
          error: errorMessage(error),
          revision: revision + 1,
        });
      }
      return Boolean(persistedScopes[key]);
    }
  },

  resetForTests: () => {
    initializationGeneration += 1;
    persistenceQueue = Promise.resolve();
    persistedScopesByUserId.clear();
    set({
      activeUserId: null,
      initialized: false,
      scopes: {},
      error: null,
      revision: 0,
    });
  },
}));
