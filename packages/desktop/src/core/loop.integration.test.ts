import { describe, it, expect } from "vitest";
import { runChatLoop } from "./loop";
import type { StreamEvent, ToolDefinition } from "./types";

const apiKey = import.meta.env.OPENROUTER_API_KEY as string | undefined;

describe("runChatLoop integration", () => {
  it.skipIf(!apiKey)("tool use end-to-end", async () => {
    const weatherTool: ToolDefinition = {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "The city name" },
        },
        required: ["city"],
      },
      execute: async (args) => {
        const city = (args as { city: string }).city;
        return { city, temperature: 22, condition: "sunny", unit: "celsius" };
      },
    };

    const events: StreamEvent[] = [];
    await runChatLoop({
      apiKey: apiKey!,
      model: "openai/gpt-4.1-nano",
      messages: [{ role: "user", content: "What's the weather in Paris? Use the tool." }],
      tools: [weatherTool],
      params: { temperature: 0 },
      onEvents: (batch) => events.push(...batch),
    });

    // Should have a tool-result event
    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.type === "tool-result") {
      expect(toolResult.toolName).toBe("get_weather");
      expect(toolResult.isError).toBe(false);
    }

    // Should have a finish event
    expect(events.some((e) => e.type === "finish")).toBe(true);

    // Should have text deltas (the model's final response incorporating tool results)
    expect(events.some((e) => e.type === "text-delta")).toBe(true);
  }, 60000);

  it.skipIf(!apiKey)("structured output with json_schema", async () => {
    const events: StreamEvent[] = [];
    let fullText = "";

    await runChatLoop({
      apiKey: apiKey!,
      model: "openai/gpt-4.1-nano",
      messages: [
        {
          role: "user",
          content: 'Analyze the sentiment of this text: "I love sunny days". Respond with the JSON schema provided.',
        },
      ],
      params: {
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "sentiment",
            strict: true,
            schema: {
              type: "object",
              properties: {
                sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
              },
              required: ["sentiment"],
              additionalProperties: false,
            },
          },
        },
      },
      onEvents: (batch) => {
        for (const e of batch) {
          events.push(e);
          if (e.type === "text-delta") fullText += e.text;
        }
      },
    });

    expect(events.some((e) => e.type === "finish")).toBe(true);

    // Response should be valid JSON matching the schema
    const parsed = JSON.parse(fullText);
    expect(parsed).toHaveProperty("sentiment");
    expect(["positive", "negative", "neutral"]).toContain(parsed.sentiment);
  }, 30000);
});
