import { describe, expect, it } from "vitest";
import { channelDisplayName, channelSearchNames, normalizeChannelTitle, type SearchDestination } from "@thechat/shared";
import { destinationName, listDestinations, rankDestinations } from "./search";

// The display rule is shared with the API (push titles, Activity, Threads),
// so both sides name a channel the same way.
describe("channelDisplayName", () => {
  it("shows the title as typed", () => {
    expect(channelDisplayName({ name: "my-channel", title: "My Channel" })).toBe("My Channel");
  });

  it("shows channels created in lowercase exactly as before", () => {
    expect(channelDisplayName({ name: "product-updates", title: "product-updates" })).toBe("product-updates");
  });

  it("falls back to the slug when there is no usable title", () => {
    expect(channelDisplayName({ name: "legacy-ops", title: null })).toBe("legacy-ops");
    expect(channelDisplayName({ name: "legacy-ops" })).toBe("legacy-ops");
    expect(channelDisplayName({ name: "legacy-ops", title: "   " })).toBe("legacy-ops");
  });

  it("never shows a typed leading # twice", () => {
    expect(normalizeChannelTitle("  #  Launch   Plan ")).toBe("Launch Plan");
    expect(normalizeChannelTitle("##ops")).toBe("ops");
    expect(normalizeChannelTitle("C# guild")).toBe("C# guild");
    // Titles saved before this rule still read without the extra #.
    expect(channelDisplayName({ name: "ops", title: "#ops" })).toBe("ops");
    expect(channelDisplayName({ name: "ops", title: "#" })).toBe("ops");
    expect(channelSearchNames({ name: "ops", title: "#ops" })).toEqual(["ops"]);
  });

  it("uses the fallback only when the channel has no name at all", () => {
    expect(channelDisplayName({ name: null, title: null })).toBe("channel");
    expect(channelDisplayName({ name: null, title: null }, "Channel")).toBe("Channel");
  });

  it("lists every name a channel is found by, once", () => {
    expect(channelSearchNames({ name: "my-channel", title: "My Channel" })).toEqual(["My Channel", "my-channel"]);
    expect(channelSearchNames({ name: "ops", title: "ops" })).toEqual(["ops"]);
    expect(channelSearchNames({ name: "ops", title: null })).toEqual(["ops"]);
  });
});

describe("channels in the quick switcher", () => {
  const W = { workspaceId: "w1", workspaceName: "Cross-Link" };
  const friendly: SearchDestination = { kind: "channel", conversationId: "ch-my", name: "my-channel", title: "My Channel", ...W };
  const lower: SearchDestination = { kind: "channel", conversationId: "ch-ops", name: "ops", title: "ops", ...W };
  const legacy: SearchDestination = { kind: "channel", conversationId: "ch-old", name: "marketing", ...W };
  // The slug drops "é", so "café" can only match the title.
  const cafe: SearchDestination = { kind: "channel", conversationId: "ch-cafe", name: "caf-talk", title: "Café Talk", ...W };
  const person: SearchDestination = {
    kind: "person", userId: "u-mya", name: "Mya Chan", userType: "human", botKind: null, botAvatar: null,
    conversationId: null, ...W,
  };
  const pool = [friendly, lower, legacy, cafe, person];
  const shown = (list: SearchDestination[]) => list.map(destinationName);

  it("shows a channel by its title", () => {
    expect(destinationName(friendly)).toBe("My Channel");
    expect(destinationName(legacy)).toBe("marketing");
  });

  it("finds a channel by its title and by its slug", () => {
    expect(shown(rankDestinations(pool, "My Channel"))[0]).toBe("My Channel");
    expect(shown(rankDestinations(pool, "my-channel"))).toEqual(["My Channel"]);
    expect(shown(rankDestinations(pool, "#my-channel"))).toEqual(["My Channel"]);
    expect(shown(rankDestinations(pool, "marketing"))).toEqual(["marketing"]);
    expect(shown(rankDestinations(pool, "café"))).toEqual(["Café Talk"]);
    expect(shown(rankDestinations(pool, "caf-talk"))).toEqual(["Café Talk"]);
  });

  it("ranks a title prefix above a loose match on someone's name", () => {
    expect(shown(rankDestinations(pool, "my chan"))).toEqual(["My Channel", "Mya Chan"]);
  });

  it("sorts an unfiltered list by what people see", () => {
    const zeta: SearchDestination = { kind: "channel", conversationId: "ch-z", name: "a-first-slug", title: "Zeta", ...W };
    expect(shown(listDestinations([zeta, friendly], { kinds: new Set(["channel"]) }))).toEqual(["My Channel", "Zeta"]);
  });
});
