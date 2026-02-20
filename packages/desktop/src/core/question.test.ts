import { describe, it, expect, vi, beforeEach } from "vitest";

let askQuestion: typeof import("./question").askQuestion;
let onQuestionRequest: typeof import("./question").onQuestionRequest;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("./question");
  askQuestion = mod.askQuestion;
  onQuestionRequest = mod.onQuestionRequest;
});

describe("question bridge", () => {
  it("resolves when the listener calls resolve", async () => {
    onQuestionRequest((req) => {
      req.resolve([["Option A"]]);
    });

    const result = await askQuestion([
      {
        question: "Pick one",
        header: "Choice",
        options: [
          { label: "Option A", description: "First option" },
          { label: "Option B", description: "Second option" },
        ],
      },
    ]);

    expect(result).toEqual([["Option A"]]);
  });

  it("rejects when the listener calls reject", async () => {
    onQuestionRequest((req) => {
      req.reject("User cancelled");
    });

    await expect(
      askQuestion([
        {
          question: "Pick one",
          header: "Choice",
          options: [{ label: "A", description: "a" }],
        },
      ]),
    ).rejects.toThrow("User cancelled");
  });

  it("rejects if no listener is registered", async () => {
    await expect(
      askQuestion([
        {
          question: "Pick one",
          header: "Choice",
          options: [{ label: "A", description: "a" }],
        },
      ]),
    ).rejects.toThrow("No question handler registered");
  });

  it("unsubscribe removes the listener", async () => {
    const unsub = onQuestionRequest((req) => {
      req.resolve([["A"]]);
    });
    unsub();

    await expect(
      askQuestion([
        {
          question: "Pick one",
          header: "Choice",
          options: [{ label: "A", description: "a" }],
        },
      ]),
    ).rejects.toThrow("No question handler registered");
  });

  it("provides unique ids for each request", async () => {
    const ids: string[] = [];
    onQuestionRequest((req) => {
      ids.push(req.id);
      req.resolve([[]]);
    });

    await askQuestion([{ question: "Q1", header: "H", options: [{ label: "A", description: "a" }] }]);
    await askQuestion([{ question: "Q2", header: "H", options: [{ label: "A", description: "a" }] }]);

    expect(ids[0]).not.toBe(ids[1]);
  });
});
