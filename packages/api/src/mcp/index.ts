import { Elysia } from "elysia";
import { mcp } from "elysia-mcp";
import { mcpAuthenticate } from "./auth";
import { registerTools } from "./tools";

export const mcpRoutes = new Elysia().use(
  mcp({
    serverInfo: { name: "thechat", version: "0.1.0" },
    basePath: "/mcp",
    capabilities: { tools: {} },
    authentication: mcpAuthenticate,
    setupServer: async (server) => {
      registerTools(server);
    },
  })
);
