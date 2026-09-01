import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { authRoutes } from "./auth";
import { drainAuthenticationCodeDeliveries } from "./auth/better-auth";
import { authInfrastructureErrors } from "./auth/middleware";
import { workspaceRoutes } from "./workspaces";
import { workspaceConfigRoutes } from "./workspaces/config";
import { conversationRoutes } from "./conversations";
import { messageRoutes } from "./messages";
import { wsRoutes } from "./ws";
import { botRoutes } from "./bots";
import { inviteRoutes } from "./invites";
import { botWorkspaceInviteRoutes } from "./bot-workspace-invites";
import { mcpRoutes } from "./mcp";
import { hermesRoutes } from "./hermes";
import { hermesPlatformRoutes } from "./hermes-platform";
import { botRuntimeRoutes } from "./bot-runtime";
import { attachmentRoutes } from "./attachments";
import { initObservability, shutdownObservability, withSpan } from "./observability";
import { log } from "./logging";
import { apiDocumentation } from "./openapi";
import { API_TAGS, PUBLIC_SECURITY } from "./openapi-metadata";

const apiLog = log.child({ component: "api" });

function installLoopbackOnlyE2EGuard() {
  if (process.env.THECHAT_E2E_LOOPBACK_ONLY !== "1") return;

  for (const [name, value] of [
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["REDIS_URL", process.env.REDIS_URL],
    ["THECHAT_BACKEND_URL", process.env.THECHAT_BACKEND_URL],
    ["BETTER_AUTH_URL", process.env.BETTER_AUTH_URL],
  ] as const) {
    if (!value || new URL(value).hostname !== "127.0.0.1") {
      throw new Error(`${name} must use explicit loopback in E2E mode`);
    }
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!loopbackHosts.has(url.hostname)) {
      return Promise.reject(
        new Error("Loopback-only E2E mode blocked an outbound HTTP request"),
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

export const app = new Elysia()
  .use(cors())
  .use(log.into())
  .use(apiDocumentation())
  .decorate("db", db)
  .use(authInfrastructureErrors)
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
  .use(botWorkspaceInviteRoutes)
  .use(mcpRoutes)
  .get("/", () => "TheChat API", {
    detail: { tags: [API_TAGS.system], security: PUBLIC_SECURITY },
  })
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
          const e2eRunId =
            process.env.THECHAT_E2E_LOOPBACK_ONLY === "1"
              ? process.env.THECHAT_E2E_RUN_ID
              : undefined;
          return {
            status: "ok",
            db: "connected",
            ...(e2eRunId ? { e2eRunId } : {}),
          };
        } catch (e) {
          return Response.json(
            { status: "error", db: "disconnected" },
            { status: 503 }
          );
        }
      },
    );
  }, {
    detail: { tags: [API_TAGS.system], security: PUBLIC_SECURITY },
  });

export type App = typeof app;

async function startServer() {
  installLoopbackOnlyE2EGuard();
  await initObservability("thechat-api");

  const port = Number(process.env.THECHAT_BACKEND_PORT) || 3000;
  const hostname = process.env.THECHAT_BACKEND_HOST?.trim();
  app.listen(hostname ? { port, hostname } : port);

  process.once("SIGTERM", () => {
    void shutdownAndExit(143);
  });
  process.once("SIGINT", () => {
    void shutdownAndExit(130);
  });

  apiLog.info(
    { hostname: app.server!.hostname, port: app.server!.port },
    "TheChat API is running",
  );
}

if (import.meta.main) {
  await startServer();
}

async function shutdownAndExit(code: number) {
  app.stop();
  await drainAuthenticationCodeDeliveries().catch((error) => {
    apiLog.error(
      {
        errorClass:
          error instanceof Error ? error.constructor.name : "UnknownError",
      },
      "Failed to drain authentication code deliveries",
    );
  });
  await shutdownObservability().catch((error) => {
    apiLog.error({ err: error }, "Failed to shut down observability");
  });
  process.exit(code);
}
