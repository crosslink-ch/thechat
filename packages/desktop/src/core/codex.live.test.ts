import { describe, it, expect } from "vitest";

const accessToken = process.env.CODEX_ACCESS_TOKEN;
const accountId = process.env.CODEX_ACCOUNT_ID;

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

/** Collect SSE events from a streaming response, return parsed JSON events. */
async function collectSSE(response: Response): Promise<any[]> {
  const text = await response.text();
  const events: any[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      const payload = line.slice(6);
      if (payload === "[DONE]") break;
      try {
        events.push(JSON.parse(payload));
      } catch {
        // skip unparseable lines
      }
    }
  }
  return events;
}

describe("codex live API", () => {
  it.skipIf(!accessToken)("hello world — gets a streaming response", async () => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId;
    }

    const body = {
      model: "gpt-5.3-codex",
      instructions: "You are a helpful assistant. Keep your response very short.",
      reasoning: { effort: "low" },
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Say hello world" }],
        },
      ],
      stream: true,
      store: false,
    };

    const response = await fetch(CODEX_API_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    expect(response.ok, `API returned ${response.status}: ${await response.clone().text()}`).toBe(true);

    const events = await collectSSE(response);
    expect(events.length).toBeGreaterThan(0);

    // Should have a response.completed event
    const completed = events.find((e) => e.type === "response.completed");
    expect(completed, "expected a response.completed event").toBeDefined();

    // Extract text from output_text delta events
    const textDeltas = events
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => e.delta ?? "")
      .join("");
    expect(textDeltas.length).toBeGreaterThan(0);
  }, 60_000);
});
