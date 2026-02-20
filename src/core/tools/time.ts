import { defineTool } from "./define";

export const getCurrentTimeTool = defineTool({
  name: "get_current_time",
  description: "Get the current date and time in ISO 8601 format",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA timezone name (e.g. 'America/New_York'). Defaults to UTC.",
      },
    },
    required: [],
  },
  execute: (args) => {
    const tz = (args as { timezone?: string }).timezone || "UTC";
    return {
      time: new Date().toLocaleString("en-US", { timeZone: tz }),
      timezone: tz,
      iso: new Date().toISOString(),
    };
  },
});
