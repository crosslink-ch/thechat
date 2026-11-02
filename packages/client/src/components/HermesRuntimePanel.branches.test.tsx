import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationThreadPublic, TaskProjectPublic } from "@thechat/shared";
import { useTaskBranchExpansionStore } from "../stores/task-branch-expansion";
import { useTaskProjectExpansionStore } from "../stores/task-project-expansion";
import { HermesRuntimePanel } from "./HermesRuntimePanel";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 2, 12, minute)).toISOString();
const task = (
  id: string,
  title: string,
  { from, general = false, minute = 0, projectId = null }: {
    from?: string; general?: boolean; minute?: number; projectId?: string | null;
  } = {},
): ConversationThreadPublic => ({
  id, conversationId: "dm-1", botId: "bot-1", title, status: "active", projectId,
  branchPending: !!from || general, branchFromThreadId: from ?? null,
  createdById: "user-1", lastActivityAt: at(minute), createdAt: at(minute), updatedAt: at(minute),
});

const plan = task("plan", "Launch plan", { minute: 0 });
const draft = task("draft", "Draft announcement", { from: "plan", minute: 1 });
const review = task("review", "Legal review", { from: "draft", minute: 2 });
const alt = task("alt", "Alternative pitch", { from: "plan", minute: 3 });
const idea = task("idea", "Side idea", { general: true, minute: 4 });
const solo = task("solo", "Expenses", { minute: 5 });

function renderPanel({
  threads = [plan, draft, review, alt, idea, solo],
  activeThreadId = "solo" as string | null,
  unreadThreadIds = new Set<string>(),
  approvalThreadIds = new Set<string>(),
  projects = [] as TaskProjectPublic[],
} = {}) {
  const onBranchThread = vi.fn();
  const onSelectThread = vi.fn();
  render(
    <HermesRuntimePanel
      botName="Hermes"
      runtime={{ invocations: [], events: [] }}
      loading={false}
      threads={threads}
      projects={projects}
      activeThreadId={activeThreadId}
      unreadThreadIds={unreadThreadIds}
      approvalThreadIds={approvalThreadIds}
      onSelectThread={onSelectThread}
      onBranchThread={onBranchThread}
      onDeleteThread={vi.fn()}
    />,
  );
  return { onBranchThread, onSelectThread };
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-task-row="${id}"]`)!;

beforeEach(() => {
  useTaskBranchExpansionStore.setState(useTaskBranchExpansionStore.getInitialState());
  useTaskProjectExpansionStore.setState(useTaskProjectExpansionStore.getInitialState());
});
afterEach(cleanup);

describe("Hermes task branches in the panel", () => {
  it("nests branches and branches of branches under the task they came from", () => {
    renderPanel();
    const planBranches = screen.getByRole("group", { name: "Branches of Launch plan" });
    expect(within(planBranches).getByText("Draft announcement")).toBeInTheDocument();
    expect(within(planBranches).getByText("Alternative pitch")).toBeInTheDocument();
    const draftBranches = within(planBranches).getByRole("group", {
      name: "Branches of Draft announcement",
    });
    expect(within(draftBranches).getByText("Legal review")).toBeInTheDocument();
    // Branches show the branch icon; a plain task does not.
    expect(row("review").dataset.taskBranch).toBe("true");
    expect(row("solo").dataset.taskBranch).toBeUndefined();
    // A branch of General says where it came from, since it has no parent row.
    expect(within(row("idea")).getByText("from General")).toBeInTheDocument();
  });

  it("folds a tree and keeps what needs attention visible on the source row", async () => {
    const user = userEvent.setup();
    renderPanel({ approvalThreadIds: new Set(["review"]), unreadThreadIds: new Set(["alt"]) });
    await user.click(screen.getByRole("button", { name: "Hide 3 branches of Launch plan" }));
    expect(screen.queryByText("Legal review")).not.toBeInTheDocument();
    expect(screen.queryByText("Alternative pitch")).not.toBeInTheDocument();
    // A pending review inside outranks unread replies.
    const toggle = screen.getByRole("button", {
      name: "Show 3 branches of Launch plan, a branch needs your review",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    expect(screen.getByText("Legal review")).toBeInTheDocument();
  });

  it("unfolds the trees around a branch that is opened from elsewhere", () => {
    useTaskBranchExpansionStore.getState().setBranchesCollapsed("plan", true);
    useTaskBranchExpansionStore.getState().setBranchesCollapsed("draft", true);
    renderPanel({ activeThreadId: "review" });
    // Both folded trees above the open branch were unfolded to reveal it.
    expect(screen.getByRole("group", { name: "Branches of Launch plan" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Branches of Draft announcement" })).toBeInTheDocument();
    expect(row("review").querySelector('[aria-current="true"]')).not.toBeNull();
  });

  it("keeps folds across a remount, like project expansion", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Hide 1 branch of Draft announcement" }));
    cleanup();
    renderPanel();
    expect(screen.queryByText("Legal review")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show 1 branch of Draft announcement" })).toBeInTheDocument();
  });

  it("branches any task from its row menu", async () => {
    const user = userEvent.setup();
    const { onBranchThread, onSelectThread } = renderPanel();
    await user.click(screen.getByRole("button", { name: "Task actions for Alternative pitch" }));
    await user.click(screen.getByRole("menuitem", { name: "Branch from here" }));
    expect(onBranchThread).toHaveBeenCalledWith("alt");
    expect(onSelectThread).not.toHaveBeenCalled();
  });

  it("shows a branch filed in another project at the top of that project, naming its source", () => {
    const research = { id: "research", conversationId: "dm-1", name: "Research", createdById: "user-1", createdAt: at(0), updatedAt: at(0) };
    useTaskProjectExpansionStore.getState().setProjectExpanded("research", true);
    renderPanel({
      projects: [research],
      threads: [plan, { ...alt, projectId: "research" }],
    });
    const group = screen.getByRole("group", { name: "Project Research" });
    expect(within(group).getByText("Alternative pitch")).toBeInTheDocument();
    expect(within(group).getByText("from Launch plan")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Branches of Launch plan" })).not.toBeInTheDocument();
  });
});
