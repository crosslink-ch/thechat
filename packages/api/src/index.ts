import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { authRoutes } from "./auth";
import { workspaceRoutes } from "./workspaces";
import { conversationRoutes } from "./conversations";
import { messageRoutes } from "./messages";
import { wsRoutes } from "./ws";

const app = new Elysia()
  .use(cors())
  .decorate("db", db)
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(wsRoutes)
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

app.listen(3000);

console.log(`TheChat API running at http://localhost:${app.server!.port}`);
