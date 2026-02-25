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

function getQueue(convId = CONV_ID) {
  return useQuestionStore.getState().pending[convId] ?? [];
}

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

    const queue = getQueue();
    expect(queue).toHaveLength(1);
    queue[0].resolve([["Option A"]]);

    const result = await promise;
    expect(result).toEqual([["Option A"]]);
    expect(getQueue()).toHaveLength(0);
  });

  it("rejects when the UI calls reject", async () => {
    const promise = askQuestion(
      [{ question: "Pick one", header: "Choice", options: [{ label: "A", description: "a" }] }],
      CONV_ID,
    );

    getQueue()[0].reject("User cancelled");

    await expect(promise).rejects.toThrow("User cancelled");
    expect(getQueue()).toHaveLength(0);
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
    expect(state["conv-a"]?.[0]?.questions[0].question).toBe("Q1");
    expect(state["conv-b"]?.[0]?.questions[0].question).toBe("Q2");

    state["conv-a"][0].resolve([["A"]]);
    await p1;
    expect(useQuestionStore.getState().pending["conv-a"]).toBeUndefined();
    expect(useQuestionStore.getState().pending["conv-b"]).toHaveLength(1);

    state["conv-b"][0].resolve([["B"]]);
    await p2;
  });

  it("queues multiple concurrent requests for the same conversation", async () => {
    const p1 = askQuestion(
      [{ question: "Q1", header: "H", options: [{ label: "A", description: "a" }] }],
      CONV_ID,
    );
    const p2 = askQuestion(
      [{ question: "Q2", header: "H", options: [{ label: "B", description: "b" }] }],
      CONV_ID,
    );

    expect(getQueue()).toHaveLength(2);
    expect(getQueue()[0].questions[0].question).toBe("Q1");
    expect(getQueue()[1].questions[0].question).toBe("Q2");

    // Resolve first
    getQueue()[0].resolve([["A"]]);
    await p1;
    expect(getQueue()).toHaveLength(1);
    expect(getQueue()[0].questions[0].question).toBe("Q2");

    // Reject second
    getQueue()[0].reject("cancelled");
    await expect(p2).rejects.toThrow("cancelled");
    expect(getQueue()).toHaveLength(0);
  });

  it("provides unique ids for each request", async () => {
    const ids: string[] = [];

    const p1 = askQuestion([{ question: "Q1", header: "H", options: [{ label: "A", description: "a" }] }], CONV_ID);
    ids.push(getQueue()[0].id);
    getQueue()[0].resolve([[]]);
    await p1;

    const p2 = askQuestion([{ question: "Q2", header: "H", options: [{ label: "A", description: "a" }] }], CONV_ID);
    ids.push(getQueue()[0].id);
    getQueue()[0].resolve([[]]);
    await p2;

    expect(ids[0]).not.toBe(ids[1]);
  });

  it("uses _default key when no convId provided", async () => {
    const promise = askQuestion([{ question: "Q", header: "H", options: [{ label: "A", description: "a" }] }]);

    expect(useQuestionStore.getState().pending["_default"]).toHaveLength(1);
    useQuestionStore.getState().pending["_default"][0].resolve([["A"]]);
    await promise;
  });
});
