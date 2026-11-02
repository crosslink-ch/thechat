import type { ConversationThreadPublic } from "@thechat/shared";

/**
 * Hermes task branches as a tree. A task records the task it was branched
 * from (`branchFromThreadId`); a branch of the General lane has no source
 * task but is still marked `branchPending`. Everything here works on the
 * tasks a client has loaded, so a branch whose source is not loaded (or is
 * filed in another project) is a root of the list it is shown in.
 */

type BranchFields = Pick<
  ConversationThreadPublic,
  "id" | "branchFromThreadId" | "branchPending" | "lastActivityAt" | "createdAt"
>;

export interface TaskTreeNode<T extends BranchFields = ConversationThreadPublic> {
  thread: T;
  children: TaskTreeNode<T>[];
  /** Branches below this task at any depth. */
  descendantCount: number;
  /** The newest activity in this task or any branch below it. */
  latestActivityAt: string;
}

/** Whether a task was branched from another task or from the General lane. */
export function isBranch(thread: Pick<BranchFields, "branchFromThreadId" | "branchPending">) {
  return !!thread.branchFromThreadId || thread.branchPending === true;
}

function newerFirst(
  a: { latestActivityAt: string; thread: { id: string } },
  b: { latestActivityAt: string; thread: { id: string } },
) {
  const byActivity = Date.parse(b.latestActivityAt) - Date.parse(a.latestActivityAt);
  if (byActivity) return byActivity;
  return a.thread.id < b.thread.id ? 1 : a.thread.id > b.thread.id ? -1 : 0;
}

/** Creation order, so branch numbers and positions never shift. */
function olderFirst(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) {
  const byCreation = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (byCreation) return byCreation;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Nests each task under the task it was branched from when both are in
 * `threads`. Top-level tasks are ordered by the newest activity in their
 * subtree, so a busy branch keeps its whole tree near the top; branches are
 * listed in the order they were made, so a tree does not reshuffle while
 * the user works in it.
 */
export function buildTaskTree<T extends BranchFields>(threads: readonly T[]): TaskTreeNode<T>[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const parentOf = (thread: T) => {
    const parentId = thread.branchFromThreadId ?? null;
    return parentId && parentId !== thread.id && byId.has(parentId) ? parentId : null;
  };
  // The API cannot create a cycle, but bad data must never hang the panel:
  // a task whose ancestry loops back on itself is listed as a root.
  const onCycle = (thread: T) => {
    const seen = new Set<string>([thread.id]);
    for (let parentId = parentOf(thread); parentId; parentId = parentOf(byId.get(parentId)!)) {
      if (seen.has(parentId)) return true;
      seen.add(parentId);
    }
    return false;
  };

  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const thread of threads) {
    const parentId = parentOf(thread);
    if (!parentId || onCycle(thread)) roots.push(thread);
    else childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), thread]);
  }

  const build = (thread: T): TaskTreeNode<T> => {
    const children = [...(childrenOf.get(thread.id) ?? [])].sort(olderFirst).map(build);
    let latestActivityAt = thread.lastActivityAt;
    let descendantCount = 0;
    for (const child of children) {
      descendantCount += 1 + child.descendantCount;
      if (Date.parse(child.latestActivityAt) > Date.parse(latestActivityAt)) {
        latestActivityAt = child.latestActivityAt;
      }
    }
    return { thread, children, descendantCount, latestActivityAt };
  };
  return roots.map(build).sort(newerFirst);
}

/** Every task below a tree node, at any depth. */
export function subtreeThreads<T extends BranchFields>(node: TaskTreeNode<T>): T[] {
  return node.children.flatMap((child) => [child.thread, ...subtreeThreads(child)]);
}

export interface TaskLineage<T extends BranchFields> {
  /** Loaded tasks this one was branched from, oldest first. */
  ancestors: T[];
  /** The chain starts at the General lane rather than at a plain task. */
  fromGeneral: boolean;
  /** The first source task that is not loaded, so the chain is incomplete. */
  missingAncestorId: string | null;
}

/** The tasks a task was branched from, back to the General lane or a plain task. */
export function taskLineage<T extends BranchFields>(
  thread: T | null | undefined,
  threads: readonly T[],
): TaskLineage<T> {
  const ancestors: T[] = [];
  if (!thread || !isBranch(thread)) {
    return { ancestors, fromGeneral: false, missingAncestorId: null };
  }
  const byId = new Map(threads.map((item) => [item.id, item]));
  const seen = new Set<string>([thread.id]);
  let current = thread;
  for (;;) {
    const parentId = current.branchFromThreadId ?? null;
    if (!parentId || seen.has(parentId)) {
      return {
        ancestors: ancestors.reverse(),
        fromGeneral: !parentId && current.branchPending === true,
        missingAncestorId: null,
      };
    }
    const parent = byId.get(parentId);
    if (!parent) {
      return { ancestors: ancestors.reverse(), fromGeneral: false, missingAncestorId: parentId };
    }
    seen.add(parentId);
    ancestors.push(parent);
    current = parent;
  }
}

/**
 * Direct branches of a task, or with null of the General lane, in the order
 * they were made.
 */
export function childBranches<T extends BranchFields>(
  sourceId: string | null,
  threads: readonly T[],
): T[] {
  return threads
    .filter((thread) =>
      sourceId === null
        ? thread.branchPending === true && !thread.branchFromThreadId
        : thread.branchFromThreadId === sourceId && thread.id !== sourceId,
    )
    .sort(olderFirst);
}

const MAX_GENERATED_TITLE = 48;

/**
 * A default name for a new branch: "<source> branch", numbered when the
 * source already has a branch of that name, so siblings stay distinguishable
 * until Hermes or the user names them. A source of null means General.
 */
export function nextBranchTitle(
  sourceTitle: string | null | undefined,
  siblingTitles: readonly string[],
) {
  const source = sourceTitle?.trim().replace(/\s+/g, " ");
  const named = source && source !== "New task" ? source : null;
  const taken = new Set(siblingTitles.map((title) => title.trim()));
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? "" : ` ${n}`;
    let title = `Branch${suffix}`;
    if (named) {
      const room = MAX_GENERATED_TITLE - " branch".length - suffix.length;
      const base = named.length > room ? `${named.slice(0, room - 3)}...` : named;
      title = `${base} branch${suffix}`;
    }
    if (!taken.has(title)) return title;
  }
}

/**
 * The loaded branches that move with a task when it changes project: those
 * still filed where the task was, at any depth. As on the server, a branch
 * filed somewhere else stops the walk, together with what grew from it.
 */
export function branchesInProject<
  T extends BranchFields & Pick<ConversationThreadPublic, "projectId">,
>(threadId: string, projectId: string | null, threads: readonly T[]): T[] {
  const moved: T[] = [];
  const seen = new Set<string>([threadId]);
  let frontier = [threadId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const thread of threads) {
      if (
        thread.branchFromThreadId &&
        frontier.includes(thread.branchFromThreadId) &&
        !seen.has(thread.id) &&
        (thread.projectId ?? null) === projectId
      ) {
        seen.add(thread.id);
        moved.push(thread);
        next.push(thread.id);
      }
    }
    frontier = next;
  }
  return moved;
}
