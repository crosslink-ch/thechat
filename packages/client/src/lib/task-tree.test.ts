import { describe, expect, it } from "vitest";
import type { ConversationThreadPublic } from "@thechat/shared";
import {
  branchesInProject,
  buildTaskTree,
  childBranches,
  nextBranchTitle,
  taskLineage,
  type TaskTreeNode,
} from "./task-tree";

const base = Date.UTC(2026, 10, 2, 12, 0);
const minutes = (n: number) => new Date(base + n * 60_000).toISOString();

function task(
  id: string,
  {
    from,
    general = false,
    created = 0,
    active = created,
    projectId = null,
  }: {
    from?: string;
    general?: boolean;
    created?: number;
    active?: number;
    projectId?: string | null;
  } = {},
): ConversationThreadPublic {
  return {
    id,
    conversationId: "dm-1",
    botId: "bot-1",
    title: id,
    status: "active",
    branchPending: !!from || general,
    branchFromThreadId: from ?? null,
    projectId,
    createdById: "user-1",
    lastActivityAt: minutes(active),
    createdAt: minutes(created),
    updatedAt: minutes(active),
  };
}

/** The tree as nested ids, e.g. ["plan", ["draft", ["review"]]]. */
function shape(nodes: TaskTreeNode[]): unknown[] {
  return nodes.map((node) =>
    node.children.length ? [node.thread.id, ...shape(node.children)] : node.thread.id,
  );
}

describe("buildTaskTree", () => {
  it("nests branches under their source and orders top-level trees by their newest activity", () => {
    const tree = buildTaskTree([
      task("plan", { created: 0, active: 1 }),
      task("draft", { from: "plan", created: 2, active: 3 }),
      task("review", { from: "draft", created: 4, active: 50 }),
      task("budget", { created: 5, active: 20 }),
      task("alt", { from: "plan", created: 6, active: 7 }),
    ]);
    // "review" is the newest activity anywhere, so its whole tree leads.
    expect(shape(tree)).toEqual([["plan", ["draft", "review"], "alt"], "budget"]);
    expect(tree[0]!.descendantCount).toBe(3);
    expect(tree[0]!.latestActivityAt).toBe(minutes(50));
  });

  it("keeps branches in creation order so a tree does not reshuffle while you work in it", () => {
    const tree = buildTaskTree([
      task("plan"),
      task("first", { from: "plan", created: 1, active: 1 }),
      task("second", { from: "plan", created: 2, active: 90 }),
    ]);
    expect(shape(tree)).toEqual([["plan", "first", "second"]]);
  });

  it("lists a branch whose source is not loaded at the top level", () => {
    const tree = buildTaskTree([
      task("orphan", { from: "on-another-page", active: 5 }),
      task("from-general", { general: true, active: 4 }),
    ]);
    expect(shape(tree)).toEqual(["orphan", "from-general"]);
  });

  it("never loops on corrupt cyclic data", () => {
    const tree = buildTaskTree([task("a", { from: "b" }), task("b", { from: "a" }), task("c")]);
    expect(tree.map((node) => node.thread.id).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("taskLineage", () => {
  const threads = [
    task("plan"),
    task("draft", { from: "plan" }),
    task("review", { from: "draft" }),
    task("idea", { general: true }),
    task("idea-2", { from: "idea" }),
  ];

  it("walks back to the plain task a branch started from", () => {
    const lineage = taskLineage(threads[2], threads);
    expect(lineage.ancestors.map((thread) => thread.id)).toEqual(["plan", "draft"]);
    expect(lineage.fromGeneral).toBe(false);
  });

  it("reports General as the start of a General branch's chain", () => {
    const lineage = taskLineage(threads[4], threads);
    expect(lineage.ancestors.map((thread) => thread.id)).toEqual(["idea"]);
    expect(lineage.fromGeneral).toBe(true);
  });

  it("names the first source that is not loaded", () => {
    const lineage = taskLineage(task("x", { from: "gone" }), threads);
    expect(lineage).toEqual({ ancestors: [], fromGeneral: false, missingAncestorId: "gone" });
  });

  it("is empty for a plain task", () => {
    expect(taskLineage(threads[0], threads).ancestors).toEqual([]);
  });
});

describe("childBranches", () => {
  it("lists direct branches of a task, or of General, oldest first", () => {
    const threads = [
      task("plan"),
      task("b", { from: "plan", created: 2 }),
      task("a", { from: "plan", created: 1 }),
      task("deep", { from: "a" }),
      task("g", { general: true }),
      task("plain"),
    ];
    expect(childBranches("plan", threads).map((t) => t.id)).toEqual(["a", "b"]);
    expect(childBranches(null, threads).map((t) => t.id)).toEqual(["g"]);
  });
});

describe("nextBranchTitle", () => {
  it("names a branch after its source and numbers siblings of the same name", () => {
    expect(nextBranchTitle("Pricing", [])).toBe("Pricing branch");
    expect(nextBranchTitle("Pricing", ["Pricing branch"])).toBe("Pricing branch 2");
    expect(nextBranchTitle("Pricing", ["Pricing branch", "Pricing branch 2"])).toBe("Pricing branch 3");
    // A renamed sibling frees its default name.
    expect(nextBranchTitle("Pricing", ["EU pricing"])).toBe("Pricing branch");
  });

  it("falls back to Branch for General or an unnamed task and stays within the title budget", () => {
    expect(nextBranchTitle(null, ["Branch"])).toBe("Branch 2");
    expect(nextBranchTitle("New task", [])).toBe("Branch");
    const long = nextBranchTitle("x".repeat(80), []);
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith("... branch")).toBe(true);
  });
});

describe("branchesInProject", () => {
  it("takes every branch still filed with the task and stops at one filed elsewhere", () => {
    const threads = [
      task("root", { projectId: "research" }),
      task("child", { from: "root", projectId: "research" }),
      task("grandchild", { from: "child", projectId: "research" }),
      task("moved", { from: "root", projectId: "launch" }),
      task("under-moved", { from: "moved", projectId: "research" }),
    ];
    expect(branchesInProject("root", "research", threads).map((t) => t.id)).toEqual([
      "child",
      "grandchild",
    ]);
  });
});
