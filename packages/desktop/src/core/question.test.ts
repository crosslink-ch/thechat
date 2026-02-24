import { describe, it, expect, vi, beforeEach } from "vitest";

let askQuestion: typeof import("./question").askQuestion;
let useQuestionStore: typeof import("./question").useQuestionStore;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("./question");
  askQuestion = mod.askQuestion;
  useQuestionStore = mod.useQuestionStore;
  useQuestionStore.setState({ pending: {} });
});

const CONV_ID = "conv-1";

describe("question store", () => {
  it("resolves when the UI calls resolve", async () => {
    const promise = askQuestion(
      [
        {
          question: "Pick one",
          header: "Choice",
          options: [
            { label: "Option A", description: "First option" },
            { label: "Option B", description: "Second option" },
          ],
        },
      ],
      CONV_ID,
    );

    const pending = useQuestionStore.getState().pending[CONV_ID];
    expect(pending).toBeDefined();
    pending.resolve([["Option A"]]);

    const result = await promise;
    expect(result).toEqual([["Option A"]]);
    expect(useQuestionStore.getState().pending[CONV_ID]).toBeUndefined();
  });

  it("rejects when the UI calls reject", async () => {
    const promise = askQuestion(
      [{ question: "Pick one", header: "Choice", options: [{ label: "A", description: "a" }] }],
      CONV_ID,
    );

    useQuestionStore.getState().pending[CONV_ID].reject("User cancelled");

    await expect(promise).rejects.toThrow("User cancelled");
    expect(useQuestionStore.getState().pending[CONV_ID]).toBeUndefined();
  });

  it("scopes pending requests by conversation ID", async () => {
    const p1 = askQuestion(
      [{ question: "Q1", header: "H", options: [{ label: "A", description: "a" }] }],
      "conv-a",
    );
    const p2 = askQuestion(
      [{ question: "Q2", header: "H", options: [{ label: "B", description: "b" }] }],
      "conv-b",
    );

    const state = useQuestionStore.getState().pending;
    expect(state["conv-a"]?.questions[0].question).toBe("Q1");
    expect(state["conv-b"]?.questions[0].question).toBe("Q2");

    state["conv-a"].resolve([["A"]]);
    await p1;
    expect(useQuestionStore.getState().pending["conv-a"]).toBeUndefined();
    expect(useQuestionStore.getState().pending["conv-b"]).toBeDefined();

    state["conv-b"].resolve([["B"]]);
    await p2;
  });

  it("provides unique ids for each request", async () => {
    const ids: string[] = [];

    const p1 = askQuestion([{ question: "Q1", header: "H", options: [{ label: "A", description: "a" }] }], CONV_ID);
    ids.push(useQuestionStore.getState().pending[CONV_ID].id);
    useQuestionStore.getState().pending[CONV_ID].resolve([[]]);
    await p1;

    const p2 = askQuestion([{ question: "Q2", header: "H", options: [{ label: "A", description: "a" }] }], CONV_ID);
    ids.push(useQuestionStore.getState().pending[CONV_ID].id);
    useQuestionStore.getState().pending[CONV_ID].resolve([[]]);
    await p2;

    expect(ids[0]).not.toBe(ids[1]);
  });

  it("uses _default key when no convId provided", async () => {
    const promise = askQuestion([{ question: "Q", header: "H", options: [{ label: "A", description: "a" }] }]);

    expect(useQuestionStore.getState().pending["_default"]).toBeDefined();
    useQuestionStore.getState().pending["_default"].resolve([["A"]]);
    await promise;
  });
});
