import { Fragment, useMemo } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, ChevronRight, GitBranch, Inbox } from "lucide-react";
import type { ConversationThreadPublic } from "@thechat/shared";
import { childBranches, isBranch, taskLineage } from "../lib/task-tree";
import { menuContentClass, menuItemClass } from "./ui";

/** Ancestors beyond this many are folded into an ellipsis in the trail. */
const MAX_TRAIL_TASKS = 3;

const crumbClass =
  "min-w-0 max-w-[180px] cursor-pointer truncate rounded px-1 py-0.5 font-medium text-text-secondary transition-colors duration-150 hover:bg-hover hover:text-text";

/**
 * Where the open task sits in its branch tree: the trail of tasks it was
 * branched from (each one clickable) and a menu of the branches made from it.
 * Nothing is shown for a task that is neither a branch nor has branches.
 */
export function TaskBranchBar({
  activeThread,
  threads,
  unreadThreadIds,
  approvalThreadIds,
  onSelectThread,
}: {
  /** The open task; null is the General lane. */
  activeThread: ConversationThreadPublic | null;
  threads: readonly ConversationThreadPublic[];
  unreadThreadIds?: ReadonlySet<string>;
  approvalThreadIds?: ReadonlySet<string>;
  onSelectThread: (threadId: string | null) => void;
}) {
  const lineage = useMemo(() => taskLineage(activeThread, threads), [activeThread, threads]);
  const branches = useMemo(
    () => childBranches(activeThread?.id ?? null, threads),
    [activeThread, threads],
  );
  const branched = !!activeThread && isBranch(activeThread);
  if (!branched && branches.length === 0) return null;

  // General, then any task that is not loaded, then the loaded ancestors.
  const trail: Array<{ key: string; label: string; threadId: string | null; general?: boolean }> = [];
  if (lineage.fromGeneral) trail.push({ key: "general", label: "General", threadId: null, general: true });
  if (lineage.missingAncestorId) {
    trail.push({ key: "missing", label: "Earlier task", threadId: lineage.missingAncestorId });
  }
  for (const ancestor of lineage.ancestors) {
    trail.push({ key: ancestor.id, label: ancestor.title, threadId: ancestor.id });
  }
  const folded =
    trail.length > MAX_TRAIL_TASKS
      ? trail.slice(1, trail.length - (MAX_TRAIL_TASKS - 1))
      : [];
  const shown = folded.length > 0 ? [trail[0]!, ...trail.slice(trail.length - (MAX_TRAIL_TASKS - 1))] : trail;
  const anyUnread = branches.some((thread) => unreadThreadIds?.has(thread.id));
  const anyReview = branches.some((thread) => approvalThreadIds?.has(thread.id));

  return (
    <nav
      aria-label="Task branches"
      data-testid="task-branch-bar"
      className="flex min-h-[34px] min-w-0 shrink-0 items-center gap-2 border-b border-border-subtle bg-surface/60 px-5 py-1 text-[0.786rem] text-text-dimmed"
    >
      {branched && (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <GitBranch size={13} aria-hidden="true" className="shrink-0" />
          <span className="shrink-0">Branched from</span>
          {trail.length === 0 ? (
            <span className="truncate italic">a deleted task</span>
          ) : (
            <ol className="flex min-w-0 items-center gap-0.5">
              {shown.map((crumb, index) => (
                <Fragment key={crumb.key}>
                  {index > 0 && (
                    <li aria-hidden="true" className="shrink-0">
                      <ChevronRight size={12} />
                    </li>
                  )}
                  {index === 1 && folded.length > 0 && (
                    <>
                      <li
                        className="shrink-0 px-0.5"
                        title={folded.map((item) => item.label).join(" › ")}
                        aria-label={`${folded.length} more`}
                      >
                        …
                      </li>
                      <li aria-hidden="true" className="shrink-0">
                        <ChevronRight size={12} />
                      </li>
                    </>
                  )}
                  <li className="flex min-w-0">
                    <button
                      type="button"
                      className={`${crumbClass} flex items-center gap-1`}
                      title={crumb.label}
                      onClick={() => onSelectThread(crumb.threadId)}
                    >
                      {crumb.general && <Inbox size={12} aria-hidden="true" className="shrink-0" />}
                      <span className="truncate">{crumb.label}</span>
                    </button>
                  </li>
                </Fragment>
              ))}
            </ol>
          )}
        </div>
      )}
      {!branched && <div className="flex-1" />}
      {branches.length > 0 && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="relative flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-text-secondary transition-colors duration-150 hover:bg-hover hover:text-text data-[state=open]:bg-hover"
              aria-label={`${branches.length} ${branches.length === 1 ? "branch" : "branches"} from this ${
                activeThread ? "task" : "conversation"
              }${anyReview ? ", a branch needs your review" : anyUnread ? ", unread branches" : ""}`}
            >
              <GitBranch size={13} aria-hidden="true" />
              {branches.length} {branches.length === 1 ? "branch" : "branches"}
              <ChevronDown size={12} aria-hidden="true" />
              {(anyReview || anyUnread) && (
                <span
                  aria-hidden="true"
                  className={`absolute -top-0.5 -right-0.5 size-1.5 rounded-full ${
                    anyReview ? "bg-warning-text" : "bg-accent"
                  }`}
                />
              )}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              loop
              className={`z-50 max-w-[320px] ${menuContentClass}`}
            >
              <DropdownMenu.Label className="px-2.5 pt-1 pb-1.5 text-[0.714rem] font-medium uppercase tracking-wide text-text-dimmed">
                Branches
              </DropdownMenu.Label>
              {branches.map((thread) => (
                <DropdownMenu.Item
                  key={thread.id}
                  className={menuItemClass}
                  onSelect={() => onSelectThread(thread.id)}
                >
                  <GitBranch size={14} className="shrink-0 text-text-dimmed" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                  {approvalThreadIds?.has(thread.id) ? (
                    <span className="shrink-0 text-[0.643rem] font-medium uppercase text-warning-text">
                      Review
                    </span>
                  ) : unreadThreadIds?.has(thread.id) ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="Unread" />
                  ) : null}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </nav>
  );
}

/** What an empty branch says before its first message. */
export function BranchEmptyState({
  sourceTitle,
}: {
  /** The task the branch came from; null for General. */
  sourceTitle: string | null;
}) {
  const source = sourceTitle ? `“${sourceTitle}”` : "General";
  return (
    <div className="flex max-w-[420px] flex-col items-center gap-2 px-6 text-center" data-testid="branch-empty-state">
      <span className="flex size-9 items-center justify-center rounded-lg border border-border-subtle bg-raised text-text-muted">
        <GitBranch size={18} aria-hidden="true" />
      </span>
      <div className="text-[0.929rem] font-medium text-text-secondary">Branch of {source}</div>
      <div className="text-[0.857rem] text-text-dimmed">
        Hermes picks up from where {source} is when you send your first message here.
        Nothing you send here changes {source}.
      </div>
    </div>
  );
}
