import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../components/Markdown";
import { mentionsName, type MentionNames } from "./remark-mentions";

const names: MentionNames = { names: ["Bruno", "Razvan Cuceu", "Razvan", "Guardian"], self: "Tony" };

function pills(content: string) {
  const { container } = render(<Markdown content={content} mentions={names} />);
  return [...container.querySelectorAll(".md-mention")].map((pill) => [
    pill.textContent,
    pill.classList.contains("md-mention-self"),
  ]);
}

describe("remarkMentions", () => {
  it("shows members, multi-word names and bots as pills, and you in amber", () => {
    expect(pills("@Razvan Cuceu and @bruno, ask @Guardian. Thanks @Tony!")).toEqual([
      ["@Razvan Cuceu", false],
      ["@bruno", false],
      ["@Guardian", false],
      ["@Tony", true],
    ]);
  });

  it("leaves unknown names, longer words, emails and code alone", () => {
    expect(pills("@Brunos team, mail bruno@example.test, run `@Bruno`, or @nobody.")).toEqual([]);
  });
});

describe("mentionsName", () => {
  it("detects a mention of one person", () => {
    expect(mentionsName("Yo yo @Tony I was not online", "Tony")).toBe(true);
    expect(mentionsName("Hi @Tonya", "Tony")).toBe(false);
    expect(mentionsName("tony@example.test", "Tony")).toBe(false);
  });
});
