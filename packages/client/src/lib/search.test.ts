import { describe, expect, it } from "vitest";
import type { SearchDestination } from "@thechat/shared";
import {
  canSearchMessages,
  formatSearchTime,
  highlightParts,
  listDestinations,
  parsePaletteQuery,
  rankDestinations,
} from "./search";

const W = { workspaceId: "w1", workspaceName: "Cross-Link" };
const person = (name: string, extra: Partial<SearchDestination> = {}): SearchDestination =>
  ({
    kind: "person", userId: `u-${name}`, name, userType: "human", botKind: null, botAvatar: null,
    conversationId: `dm-${name}`, ...W, ...extra,
  }) as SearchDestination;
const channel = (name: string, workspaceId = "w1"): SearchDestination => ({
  kind: "channel", conversationId: `ch-${name}`, name, workspaceId, workspaceName: workspaceId,
});
const task = (title: string): SearchDestination => ({
  kind: "task", conversationId: "dm-koda", conversationName: "Koda", threadId: `t-${title}`, title,
  lastActivityAt: "2026-11-01T00:00:00.000Z", ...W,
});
const names = (list: SearchDestination[]) => list.map((item) => (item.kind === "task" ? item.title : item.name));

describe("parsePaletteQuery", () => {
  it("reads an optional mode prefix", () => {
    expect(parsePaletteQuery("koda")).toEqual({ mode: "all", text: "koda" });
    expect(parsePaletteQuery("@ simon")).toEqual({ mode: "people", text: "simon" });
    expect(parsePaletteQuery("#gen")).toEqual({ mode: "channels", text: "gen" });
    expect(parsePaletteQuery("?release notes")).toEqual({ mode: "messages", text: "release notes" });
    expect(parsePaletteQuery(">settings")).toEqual({ mode: "commands", text: "settings" });
  });
});

describe("rankDestinations", () => {
  const pool = [person("Simon"), person("Simone"), channel("simulations"), person("Koda"), task("Simon's invoice")];

  it("puts exact before prefix before word before subsequence", () => {
    // A loose subsequence ("s-i-m-o-n" in "simulations") still matches, last.
    expect(names(rankDestinations(pool, "simon"))).toEqual(["Simon", "Simone", "Simon's invoice", "simulations"]);
    expect(names(rankDestinations([person("Koda"), channel("kda-ops")], "kda"))).toEqual(["kda-ops", "Koda"]);
  });

  it("ignores case and accents", () => {
    expect(names(rankDestinations([person("Bruno Ribarić")], "ribaric"))).toEqual(["Bruno Ribarić"]);
  });

  it("lets recency and the current workspace break ties, not beat a better match", () => {
    const tie = [channel("ops", "w2"), channel("ops", "w1")];
    expect(rankDestinations(tie, "ops", { activeWorkspaceId: "w1" })[0]!.workspaceId).toBe("w1");
    expect(
      names(rankDestinations([channel("ops"), channel("ops-archive")], "ops", { recent: ["ch-ops-archive"] })),
    ).toEqual(["ops", "ops-archive"]);
  });

  it("lists recent places, in order, for an empty query", () => {
    expect(names(rankDestinations(pool, "", { recent: ["dm-koda:t-Simon's invoice", "dm-Simon", "gone"] }))).toEqual([
      "Simon's invoice",
      "Simon",
    ]);
  });

  it("filters by kind", () => {
    expect(names(rankDestinations(pool, "sim", { kinds: new Set(["channel"]) }))).toEqual(["simulations"]);
    expect(names(listDestinations(pool, { kinds: new Set(["task"]) }))).toEqual(["Simon's invoice"]);
  });
});

describe("canSearchMessages", () => {
  it("needs two characters of real text", () => {
    expect(canSearchMessages("a")).toBe(false);
    expect(canSearchMessages('""')).toBe(false);
    expect(canSearchMessages("ab")).toBe(true);
  });
});

describe("highlightParts", () => {
  it("marks every term, case-insensitively, longest first", () => {
    expect(highlightParts("Release notes for the release", "release")).toEqual([
      { text: "Release", match: true },
      { text: " notes for the ", match: false },
      { text: "release", match: true },
    ]);
    expect(highlightParts("ship release notes", '"release notes" ship')).toEqual([
      { text: "ship", match: true },
      { text: " ", match: false },
      { text: "release notes", match: true },
    ]);
  });
});

describe("formatSearchTime", () => {
  const now = new Date(2026, 10, 6, 15, 0);
  it("is short for recent messages and dated for old ones", () => {
    expect(formatSearchTime(new Date(2026, 10, 6, 9, 5).toISOString(), now)).toMatch(/09.05/);
    expect(formatSearchTime(new Date(2025, 0, 3).toISOString(), now)).toMatch(/2025/);
    expect(formatSearchTime("nonsense", now)).toBe("");
  });
});
