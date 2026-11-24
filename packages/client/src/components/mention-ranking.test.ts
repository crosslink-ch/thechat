import { describe, expect, it } from "vitest";
import { mentionDiscriminators, rankMentionCandidates } from "./mention-ranking";
import type { MentionUser } from "./MentionList";

const people = (...labels: string[]): MentionUser[] =>
  labels.map((label, index) => ({ id: `${index}-${label}`, label, type: "human" }));

describe("@ menu ranking", () => {
  it("puts prefix matches first, then word starts, then other matches, people before agents", () => {
    const candidates: MentionUser[] = [
      ...people("Marta Ko", "Koda Fan", "Bako"),
      { id: "bot-koda", label: "Koda", type: "bot" },
      { id: "bot-ops", label: "Ops Kollege", type: "bot" },
    ];
    expect(rankMentionCandidates(candidates, "ko").map((item) => item.label)).toEqual([
      "Koda Fan", // prefix
      "Marta Ko", // word start
      "Bako", // substring
      "Koda", // agents after people
      "Ops Kollege",
    ]);
  });

  it("only shows a discriminator when two candidates share a name", () => {
    const items: MentionUser[] = [
      { id: "aaaa1111-x", label: "Sam", type: "human" },
      { id: "bbbb2222-y", label: "sam", type: "bot", detail: "Hermes" },
      { id: "cccc3333-z", label: "Ada", type: "human" },
    ];
    const hints = mentionDiscriminators(items);
    expect(Object.fromEntries(hints)).toEqual({
      "aaaa1111-x": "#aaaa",
      "bbbb2222-y": "Hermes · #bbbb",
    });
  });
});
