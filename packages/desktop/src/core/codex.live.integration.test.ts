import { describe, expect, it } from "vitest";
import { buildCodexRequest } from "./codex";

const LIVE_TEST = process.env.CODEX_LIVE_TEST === "1" || process.env.CODEX_LIVE_TEST === "true";
const ACCESS_TOKEN = process.env.CODEX_ACCESS_TOKEN;
const ACCOUNT_ID = process.env.CODEX_ACCOUNT_ID;
const MODEL = process.env.CODEX_LIVE_MODEL || "gpt-5.5";

function textFromCompletedResponse(response: unknown): string {
  const output = (response as { output?: unknown[] })?.output;
  if (!Array.isArray(output)) return "";

  const parts: string[] = [];
  for (const item of output as Array<Record<string, unknown>>) {
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<Record<string, unknown>>) {
      if (typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("");
}

function parseCodexSse(text: string): string {
  let output = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;

    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;

    const event = JSON.parse(data) as Record<string, unknown>;
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      output += event.delta;
    }
    if (event.type === "response.completed") {
      output ||= textFromCompletedResponse(event.response);
    }
    if (event.type === "error") {
      throw new Error(`Codex API error event: ${JSON.stringify(event)}`);
    }
  }

  return output;
}

describe.skipIf(!LIVE_TEST || !ACCESS_TOKEN)("Codex live subscription", () => {
  it("gets a Hello world response through the Codex subscription", async () => {
    const request = buildCodexRequest({
      accessToken: ACCESS_TOKEN!,
      accountId: ACCOUNT_ID || "",
      model: MODEL,
      messages: [
        {
          role: "user",
          content: "Reply with exactly this text and nothing else: Hello world",
        },
      ],
      params: {
        reasoning_effort: "low",
        verbosity: "low",
      },
      convId: `live-test-${Date.now()}`,
      turnId: `turn-${Date.now()}`,
    });

    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });
    const body = await response.text();

    expect(response.ok, body).toBe(true);
    const text = parseCodexSse(body).trim();
    expect(text, "No text extracted from Codex SSE stream").not.toBe("");
    expect(text.toLowerCase()).toContain("hello world");
  }, 60_000);
});
