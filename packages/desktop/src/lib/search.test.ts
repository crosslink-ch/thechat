import { describe, expect, it } from "vitest";
import {
  parseSearchQuery,
  searchModeQuery,
  retainSelection,
  recentDestinations,
  rememberDestination,
  messageSnippet,
} from "./search";

describe("search modes", () => {
  it.each([
    ["Koda", "jump", "all", "Koda"],
    ["", "jump", "all", ""],
    ["@ Koda", "jump", "dm", "Koda"],
    ["#general", "jump", "channel", "general"],
    ["? hello", "messages", "all", "hello"],
    ["> Settings", "commands", "all", "Settings"],
    ["plan release", "jump", "all", "plan release"],
  ])(
    "parses %s without mixing commands and destinations",
    (input, mode, kind, q) => {
      expect(parseSearchQuery(input)).toEqual({ mode, kind, q });
    },
  );
  it("clickable modes replace prefixes without losing the query", () => {
    expect(searchModeQuery("? Koda", "jump", "dm")).toBe("@ Koda");
    expect(searchModeQuery("@ Koda", "commands")).toBe("> Koda");
    expect(searchModeQuery("> Koda", "jump")).toBe("Koda");
  });
});

describe("stable result identity and private recents", () => {
  it("keeps the selected ID across server reordering and falls back when removed", () => {
    expect(retainSelection("b", [{ id: "b" }, { id: "a" }])).toBe("b");
    expect(retainSelection("b", [{ id: "c" }])).toBe("c");
    expect(retainSelection("b", [])).toBeNull();
  });
  it("stores only IDs, scopes by user and server, and intersects current access", () => {
    localStorage.clear();
    rememberDestination("server-one", "alice", "gone");
    rememberDestination("server-one", "alice", "koda");
    const allowed = [{ id: "general" }, { id: "koda" }];
    expect(recentDestinations("server-one", "alice", allowed)).toEqual([
      { id: "koda" },
      { id: "general" },
    ]);
    expect(recentDestinations("server-two", "alice", allowed)).toEqual(allowed);
    expect(recentDestinations("server-one", "bob", allowed)).toEqual(allowed);
    expect(localStorage.getItem(localStorage.key(0)!)).not.toContain("title");
  });
});

it("centres a bounded snippet on a late query hit rather than clipping away the match", () => {
  const content =
    "Earlier discussion. ".repeat(40) +
    "LAUNCH CHECKLIST" +
    " Following discussion.".repeat(40);
  const snippet = messageSnippet(content, "launch checklist");
  expect(snippet).toContain("LAUNCH CHECKLIST");
  expect(snippet.startsWith("…")).toBe(true);
  expect(snippet.endsWith("…")).toBe(true);
  expect(snippet.length).toBeLessThanOrEqual(222);
  expect(messageSnippet("short message", "message")).toBe("short message");
});
