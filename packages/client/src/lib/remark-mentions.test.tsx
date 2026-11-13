import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../components/Markdown";
import { mentionsName, messageMentionsUser, type MentionNames } from "./remark-mentions";
import type { ChatMessage } from "@thechat/shared";

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

describe("parts-v1 mention pills", () => {
  const KODA = "22222222-2222-4222-8222-222222222222";
  const TONY = "33333333-3333-4333-8333-333333333333";
  const withIds: MentionNames = {
    names: ["Koda", "Bruno"],
    self: "Tony",
    selfId: TONY,
    labels: new Map([[KODA, "Koda Prime"], [TONY, "Tony"]]),
  };

  function renderParts(parts: NonNullable<ChatMessage["parts"]>) {
    const message = { contentFormat: "parts-v1" as const, parts };
    const content = parts.map((part) => (part.type === "reference" ? `@${part.label}` : "text" in part ? part.text : "")).join("");
    const { container } = render(<Markdown content={content} message={message} mentions={withIds} />);
    return container;
  }

  it("renders pills from references (current name, snapshot fallback) and leaves typed @Names as text", () => {
    const container = renderParts([
      { type: "text", text: "Hey " },
      { type: "reference", refType: "user", refId: KODA, label: "Koda" },
      { type: "text", text: ", typed @Bruno stays text, and " },
      { type: "reference", refType: "user", refId: TONY, label: "Tony" },
      { type: "text", text: " and a former member " },
      { type: "reference", refType: "user", refId: "44444444-4444-4444-8444-444444444444", label: "Gone Person" },
    ]);
    const found = [...container.querySelectorAll(".md-mention")].map((pill) => [
      pill.textContent,
      pill.getAttribute("data-mention-id"),
      pill.classList.contains("md-mention-self"),
    ]);
    expect(found).toEqual([
      ["@Koda Prime", KODA, false],
      ["@Tony", TONY, true],
      ["@Gone Person", "44444444-4444-4444-8444-444444444444", false],
    ]);
    expect(container.textContent).toContain("typed @Bruno stays text");
  });

  it("parses the whole message as one Markdown document around a mention", () => {
    const container = renderParts([
      { type: "text", text: "**ask " },
      { type: "reference", refType: "user", refId: KODA, label: "Koda" },
      { type: "text", text: " now** and `@x " },
      { type: "reference", refType: "user", refId: KODA, label: "Koda" },
      { type: "text", text: "`" },
    ]);
    const strong = container.querySelector("strong");
    expect(strong?.querySelector(".md-mention")?.textContent).toBe("@Koda Prime");
    // Inside code the mention reads as plain text.
    expect(container.querySelector("code")?.textContent).toBe("@x @Koda Prime");
  });

  it.each([
    ["raw characters", "\uE0000\uE001"],
    ["hex references", "&#xE000;0&#xE001;"],
    ["padded hex references", "&#X0e000;0&#x0E001;"],
    ["decimal references", "&#57344;0&#57345;"],
    ["a split across text parts", "\uE000", "0\uE001"],
  ])("does not let %s in text forge a pill", (_name, ...forged) => {
    // A real reference exists, so a forged marker "0" would copy its pill.
    const container = renderParts([
      { type: "reference", refType: "user", refId: KODA, label: "Koda" },
      ...forged.map((text) => ({ type: "text" as const, text: ` ${text} ` })),
      { type: "text", text: "end" },
    ]);
    expect(container.querySelectorAll(".md-mention")).toHaveLength(1);
    expect(container.textContent).toContain("end");
  });

  it("keeps text a forged marker with a missing index would have swallowed", () => {
    const container = renderParts([{ type: "text", text: "keep &#xE000;9&#xE001; this" }]);
    expect(container.querySelectorAll(".md-mention")).toHaveLength(0);
    expect(container.textContent).toContain("keep");
    expect(container.textContent).toContain("9");
    expect(container.textContent).toContain("this");
  });
});

describe("messageMentionsUser", () => {
  const me = { id: "me-id", name: "Tony" };
  it("uses IDs for parts-v1 and names for legacy messages", () => {
    expect(
      messageMentionsUser(
        { content: "@Tony hi", contentFormat: "parts-v1", parts: [{ type: "text", text: "@Tony hi" }] },
        me,
      ),
    ).toBe(false);
    expect(
      messageMentionsUser(
        {
          content: "@Tony hi",
          contentFormat: "parts-v1",
          parts: [
            { type: "reference", refType: "user", refId: "me-id", label: "Tony" },
            { type: "text", text: " hi" },
          ],
        },
        me,
      ),
    ).toBe(true);
    expect(messageMentionsUser({ content: "@Tony hi" }, me)).toBe(true);
  });
});
