import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { wrap } from "@bogeychan/elysia-logger";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { authRoutes } from "./auth";
import { workspaceRoutes } from "./workspaces";
import { workspaceConfigRoutes } from "./workspaces/config";
import { conversationRoutes } from "./conversations";
import { messageRoutes } from "./messages";
import { wsRoutes } from "./ws";
import { botRoutes } from "./bots";
import { inviteRoutes } from "./invites";
import { mcpRoutes } from "./mcp";
import { log, pinoLog } from "./lib/logger";

const app = new Elysia()
  .use(cors())
  .use(wrap(pinoLog))
  .decorate("db", db)
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(workspaceConfigRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(wsRoutes)
  .use(botRoutes)
  .use(inviteRoutes)
  .use(mcpRoutes)
  .get("/", () => "TheChat API")
  .get("/health", async ({ db }) => {
    try {
      await db.execute(sql`SELECT 1`);
      return { status: "ok", db: "connected" };
    } catch (e) {
      return Response.json(
        { status: "error", db: "disconnected" },
        { status: 503 }
      );
    }
  });

export type App = typeof app;

app.listen(Number(process.env.THECHAT_BACKEND_PORT) || 3000);

log.info("api", "started", { port: app.server!.port });
