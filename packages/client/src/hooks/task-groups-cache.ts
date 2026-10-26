import type {
  ConversationThreadGroupPage,
  ConversationThreadGroups,
  ConversationThreadPublic,
  ConversationThreadsPage,
} from "@thechat/shared";

/**
 * Client cache of a conversation's tasks, kept per group: one group per
 * project plus one (projectId null) for tasks without a project. Each group
 * holds the tasks loaded so far and the server's exact group size.
 *
 * Paging the whole conversation by recency and grouping afterwards hid a quiet
 * project's tasks behind newer tasks elsewhere, so every group pages on its
 * own. A task changed locally (created, moved, touched) is shown in its group
 * straight away even when it is older than the group's loaded pages; loading
 * more pages later de-duplicates it.
 */

export interface TaskGroupsData {
  groups: ConversationThreadGroupPage[];
  /**
   * The server predates grouped paging: one recency-ordered list is kept in
   * the null group and group sizes are unknown.
   */
  legacy?: boolean;
}

/** What the task panel needs to know about each group. */
export interface TaskGroupSummary {
  projectId: string | null;
  /** Tasks in the group on the server, loaded or not; null when unknown. */
  totalCount: number | null;
  hasMore: boolean;
  loadingMore: boolean;
}

type WireDate = string | Date;
type WireThread = Omit<ConversationThreadPublic, "lastActivityAt" | "createdAt" | "updatedAt"> & {
  lastActivityAt: WireDate;
  createdAt: WireDate;
  updatedAt: WireDate;
};

function toIsoString(value: WireDate) {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Eden Treaty revives ISO timestamps in REST responses as `Date` objects,
 * while WebSocket events carry strings. The cache always holds strings.
 */
export function normalizeThread(
  thread: WireThread | ConversationThreadPublic,
): ConversationThreadPublic {
  return {
    ...thread,
    projectId: thread.projectId ?? null,
    lastActivityAt: toIsoString(thread.lastActivityAt),
    createdAt: toIsoString(thread.createdAt),
    updatedAt: toIsoString(thread.updatedAt),
  };
}

export function normalizeThreadPage<T extends ConversationThreadsPage>(page: T): T {
  return { ...page, items: page.items.map(normalizeThread) };
}

/** Most recent activity first, ties broken by id descending, as the server orders. */
export function compareThreadActivity(
  a: Pick<ConversationThreadPublic, "lastActivityAt" | "id">,
  b: Pick<ConversationThreadPublic, "lastActivityAt" | "id">,
) {
  const byActivity = Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
  if (byActivity) return byActivity;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function taskGroupsFromServer(response: ConversationThreadGroups): TaskGroupsData {
  return {
    groups: response.groups.map((group) => ({
      ...normalizeThreadPage(group),
      projectId: group.projectId ?? null,
    })),
  };
}

/** Every loaded task, most recently active first. */
export function loadedThreads(data: TaskGroupsData | undefined) {
  const seen = new Set<string>();
  const threads: ConversationThreadPublic[] = [];
  for (const group of data?.groups ?? []) {
    for (const thread of group.items) {
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      threads.push(thread);
    }
  }
  return threads.sort(compareThreadActivity);
}

export function findLoadedThread(data: TaskGroupsData | undefined, threadId: string) {
  for (const group of data?.groups ?? []) {
    const thread = group.items.find((item) => item.id === threadId);
    if (thread) return thread;
  }
  return null;
}

/** The group holding a loaded task, or undefined when no group has loaded it. */
function loadedGroupOf(data: TaskGroupsData, threadId: string) {
  return data.groups.find((group) => group.items.some((item) => item.id === threadId))
    ?.projectId;
}

function groupFor(data: TaskGroupsData, thread: ConversationThreadPublic) {
  return data.legacy ? null : (thread.projectId ?? null);
}

/**
 * Per-group paging state. A legacy server has a single mixed list, reported
 * as the null group, so its group sizes are unknown.
 */
export function taskGroupSummaries(
  data: TaskGroupsData | undefined,
  loadingMore: (projectId: string | null) => boolean,
): TaskGroupSummary[] {
  return (data?.groups ?? []).map((group) => ({
    projectId: group.projectId,
    totalCount: data?.legacy ? null : Math.max(group.totalCount, group.items.length),
    hasMore: group.hasMore,
    loadingMore: loadingMore(group.projectId),
  }));
}

/** A legacy server's recency-ordered list, held as the null group. */
export function legacyTaskGroups(page: ConversationThreadsPage): TaskGroupsData {
  const normalized = normalizeThreadPage(page);
  return {
    legacy: true,
    groups: [{ ...normalized, projectId: null, totalCount: normalized.items.length }],
  };
}

function withGroup(data: TaskGroupsData, projectId: string | null): TaskGroupsData {
  if (data.groups.some((group) => group.projectId === projectId)) return data;
  return {
    ...data,
    groups: [
      ...data.groups,
      { projectId, items: [], nextCursor: null, hasMore: false, totalCount: 0 },
    ],
  };
}

function insertSorted(items: ConversationThreadPublic[], thread: ConversationThreadPublic) {
  const next = items.filter((item) => item.id !== thread.id);
  const index = next.findIndex((item) => compareThreadActivity(thread, item) < 0);
  next.splice(index === -1 ? next.length : index, 0, thread);
  return next;
}

/**
 * Puts the current version of a task in its group and keeps group sizes
 * exact. A task no group has loaded is only accepted when it is new
 * (`isNew`); otherwise its old group, and so the counts, are unknown and the
 * result is null so the caller refetches.
 */
export function upsertThread(
  data: TaskGroupsData,
  thread: ConversationThreadPublic,
  { isNew = false }: { isNew?: boolean } = {},
): TaskGroupsData | null {
  const counted = loadedGroupOf(data, thread.id);
  if (counted === undefined && !isNew) return null;
  const target = groupFor(data, thread);
  const base = withGroup(data, target);
  return {
    ...base,
    groups: base.groups.map((group) => {
      if (group.projectId === target) {
        return {
          ...group,
          items: insertSorted(group.items, thread),
          totalCount: counted === target ? group.totalCount : group.totalCount + 1,
        };
      }
      if (group.projectId === counted) {
        return {
          ...group,
          items: group.items.filter((item) => item.id !== thread.id),
          totalCount: Math.max(0, group.totalCount - 1),
        };
      }
      return group;
    }),
  };
}

/**
 * Shows an existing task fetched on its own (an opened task that is not on a
 * loaded page). The server already counts it, so group sizes do not change.
 */
export function revealThread(
  data: TaskGroupsData,
  thread: ConversationThreadPublic,
): TaskGroupsData {
  if (findLoadedThread(data, thread.id)) return data;
  const target = groupFor(data, thread);
  const base = withGroup(data, target);
  return {
    ...base,
    groups: base.groups.map((group) =>
      group.projectId === target
        ? { ...group, items: insertSorted(group.items, thread) }
        : group,
    ),
  };
}

/** Removes a loaded task; null when no group has loaded it. */
export function removeThread(data: TaskGroupsData, threadId: string): TaskGroupsData | null {
  const counted = loadedGroupOf(data, threadId);
  if (counted === undefined) return null;
  return {
    ...data,
    groups: data.groups.map((group) =>
      group.projectId === counted
        ? {
            ...group,
            items: group.items.filter((item) => item.id !== threadId),
            totalCount: Math.max(0, group.totalCount - 1),
          }
        : group,
    ),
  };
}

/** Moves a loaded task to the top of its group; null when it is not loaded. */
export function touchThread(
  data: TaskGroupsData,
  threadId: string,
  at: string,
): TaskGroupsData | null {
  const thread = findLoadedThread(data, threadId);
  if (!thread) return null;
  if (Date.parse(at) <= Date.parse(thread.lastActivityAt)) return data;
  return upsertThread(data, { ...thread, lastActivityAt: at, updatedAt: at });
}

/**
 * Mirrors a deleted project: the server moves its tasks out of every project,
 * so they join the null group. The caller still refetches, because tasks of
 * the project that were never loaded may sort above the null group's cursor.
 */
export function unfileProject(data: TaskGroupsData, projectId: string): TaskGroupsData {
  const unfile = (items: ConversationThreadPublic[]) =>
    items.map((item) => (item.projectId === projectId ? { ...item, projectId: null } : item));
  const removed = data.groups.find((group) => group.projectId === projectId);
  if (data.legacy || !removed) {
    return { ...data, groups: data.groups.map((group) => ({ ...group, items: unfile(group.items) })) };
  }
  const base = withGroup(data, null);
  return {
    ...base,
    groups: base.groups
      .filter((group) => group.projectId !== projectId)
      .map((group) =>
        group.projectId === null
          ? {
              ...group,
              items: [...group.items, ...unfile(removed.items)].sort(compareThreadActivity),
              totalCount: group.totalCount + removed.totalCount,
            }
          : group,
      ),
  };
}

/**
 * Appends the page that follows `cursor` to a group. A page fetched against a
 * cursor the group no longer has (it was reloaded meanwhile) is dropped, since
 * it would leave a gap.
 */
export function appendGroupPage(
  data: TaskGroupsData,
  projectId: string | null,
  cursor: string,
  page: ConversationThreadsPage,
): TaskGroupsData {
  const target = data.groups.find((group) => group.projectId === projectId);
  if (!target || target.nextCursor !== cursor) return data;
  const items = page.items.map(normalizeThread);
  const pageIds = new Set(items.map((item) => item.id));
  return {
    ...data,
    groups: data.groups.map((group) => {
      if (group.projectId !== projectId) {
        // The server places these tasks in `projectId` now.
        return group.items.some((item) => pageIds.has(item.id))
          ? { ...group, items: group.items.filter((item) => !pageIds.has(item.id)) }
          : group;
      }
      const loaded = new Set(group.items.map((item) => item.id));
      return {
        ...group,
        items: [...group.items, ...items.filter((item) => !loaded.has(item.id))].sort(
          compareThreadActivity,
        ),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        totalCount: page.totalCount ?? group.totalCount,
      };
    }),
  };
}
