import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
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
import { hermesRoutes } from "./hermes";
import { hermesPlatformRoutes } from "./hermes-platform";
import { botRuntimeRoutes } from "./bot-runtime";
import { attachmentRoutes } from "./attachments";
import { initObservability, shutdownObservability, withSpan } from "./observability";
import { log } from "./logging";

const apiLog = log.child({ component: "api" });

await initObservability("thechat-api");

const app = new Elysia()
  .use(cors())
  .use(log.into())
  .decorate("db", db)
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(workspaceConfigRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(attachmentRoutes)
  .use(wsRoutes)
  .use(botRoutes)
  .use(hermesRoutes)
  .use(hermesPlatformRoutes)
  .use(botRuntimeRoutes)
  .use(inviteRoutes)
  .use(mcpRoutes)
  .get("/", () => "TheChat API")
  .get("/health", async ({ db }) => {
    return withSpan(
      "http.health",
      {
        "messaging.system": "thechat",
        "http.route": "/health",
      },
      async () => {
        try {
          await db.execute(sql`SELECT 1`);
          return { status: "ok", db: "connected" };
        } catch (e) {
          return Response.json(
            { status: "error", db: "disconnected" },
            { status: 503 }
          );
        }
      },
    );
  });

export type App = typeof app;

app.listen(Number(process.env.THECHAT_BACKEND_PORT) || 3000);

process.once("SIGTERM", () => {
  void shutdownAndExit(143);
});
process.once("SIGINT", () => {
  void shutdownAndExit(130);
});

apiLog.info({ port: app.server!.port }, "TheChat API is running");

async function shutdownAndExit(code: number) {
  await shutdownObservability().catch((error) => {
    apiLog.error({ err: error }, "Failed to shut down observability");
  });
  process.exit(code);
}
