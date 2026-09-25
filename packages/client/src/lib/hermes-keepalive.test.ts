import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@thechat/shared";
import {
  foldHermesKeepAlives,
  formatRunDuration,
  humanizeToolName,
  parseKeepAlive,
} from "./hermes-keepalive";

let nextId = 0;
function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: `m-${nextId++}`,
    conversationId: "c-1",
    threadId: null,
    senderId: "bot-user",
    senderName: "Guardian",
    senderType: "bot",
    content: "",
    createdAt: "2026-09-25T07:00:00.000Z",
    ...overrides,
  };
}
const at = (minutes: number, seconds = 0) =>
  new Date(Date.UTC(2026, 8, 25, 7, minutes, seconds)).toISOString();

describe("parseKeepAlive", () => {
  it("reads elapsed time, iteration and tool from a Hermes keep-alive", () => {
    expect(
      parseKeepAlive(
        message({
          content: "⏳ Working — 3 min — iteration 14/2000, mcp__composio__COMPOSIO_SEARCH_TOOLS",
        }),
      ),
    ).toMatchObject({
      elapsedSeconds: 180,
      iteration: "14/2000",
      tool: "mcp__composio__COMPOSIO_SEARCH_TOOLS",
    });
  });

  it("ignores people, multi-line answers and other bot text", () => {
    const keepAlive = "⏳ Working — 3 min — iteration 14/2000, terminal";
    expect(parseKeepAlive(message({ senderType: "human", content: keepAlive }))).toBeNull();
    expect(parseKeepAlive(message({ content: `${keepAlive}\n\nDone.` }))).toBeNull();
    expect(parseKeepAlive(message({ content: "Working on it now." }))).toBeNull();
  });
});

describe("foldHermesKeepAlives", () => {
  it("hides keep-alives and attaches them to the bot's next answer", () => {
    const question = message({ senderId: "u-1", senderName: "Tom", senderType: "human", content: "Check PHP?", createdAt: at(0) });
    const first = message({ content: "⏳ Working — 1 min — iteration 3/2000, terminal", createdAt: at(1, 20) });
    const second = message({ content: "⏳ Working — 3 min — iteration 14/2000, web_search", createdAt: at(3, 30) });
    const answer = message({ content: "PHP is not exposed.", createdAt: at(5, 56) });

    const items = foldHermesKeepAlives([question, first, second, answer]);

    expect(items.map((item) => item.message.id)).toEqual([question.id, answer.id]);
    const run = items[1].run!;
    expect(run.updates.map((update) => update.tool)).toEqual(["terminal", "web_search"]);
    // The question pins the start, so the duration is exact.
    expect(formatRunDuration(run)).toBe("5m 56s");
  });

  it("estimates the start from the first update when the trigger does not fit", () => {
    const old = message({ senderId: "u-1", senderType: "human", content: "Earlier chat", createdAt: at(0) });
    const update = message({ content: "⏳ Working — 2 min — iteration 5/2000", createdAt: at(30) });
    const answer = message({ content: "Done", createdAt: at(33) });

    const [, folded] = foldHermesKeepAlives([old, update, answer]);

    expect(folded.run!.exact).toBe(false);
    expect(formatRunDuration(folded.run!)).toBe("5m");
  });

  it("keeps a run without an answer as a trailing working item", () => {
    const question = message({ senderId: "u-1", senderType: "human", content: "Go", createdAt: at(0) });
    const update = message({ content: "⏳ Working — 2 min — iteration 5/2000, read_file", createdAt: at(2, 10) });

    const items = foldHermesKeepAlives([question, update], Date.parse(at(3)));

    expect(items.map((item) => item.kind)).toEqual(["message", "working"]);
    expect(formatRunDuration(items[1].run!)).toBe("3m");
  });
});

describe("humanizeToolName", () => {
  it("turns tool identifiers into readable names", () => {
    expect(humanizeToolName("mcp__composio__COMPOSIO_SEARCH_TOOLS")).toBe("Composio search tools");
    expect(humanizeToolName("web_search")).toBe("Web search");
  });
});
