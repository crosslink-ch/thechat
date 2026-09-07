import { afterAll, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { authRoutes } from ".";
import { workspaceRoutes } from "../workspaces";
import { workspaceConfigRoutes } from "../workspaces/config";
import { conversationRoutes } from "../conversations";
import { messageRoutes } from "../messages";
import { inviteRoutes } from "../invites";
import { botWorkspaceInviteRoutes } from "../bot-workspace-invites";
import { botRoutes } from "../bots";
import { hermesRoutes } from "../hermes";
import { botRuntimeRoutes } from "../bot-runtime";
import { attachmentRoutes } from "../attachments";
import {
  authInfrastructureErrors,
  optionalAuth,
  requireAuth,
} from "./middleware";

const saved = {
  origins: process.env.THECHAT_WEB_ORIGINS,
  backend: process.env.BETTER_AUTH_URL,
};
process.env.THECHAT_WEB_ORIGINS = "https://chat.example.test";
process.env.BETTER_AUTH_URL = "https://api.example.test";
const email = `cookie-products-${crypto.randomUUID()}@test.com`;
const app = new Elysia()
  .use(authInfrastructureErrors)
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(workspaceConfigRoutes)
  .use(conversationRoutes)
  .use(messageRoutes)
  .use(inviteRoutes)
  .use(botWorkspaceInviteRoutes)
  .use(botRoutes)
  .use(hermesRoutes)
  .use(botRuntimeRoutes)
  .use(attachmentRoutes)
  .use(
    new Elysia()
      .use(requireAuth)
      .get("/required", ({ user }) => ({ id: user.id })),
  )
  .use(
    new Elysia()
      .use(optionalAuth)
      .get("/optional", ({ user }) =>
        user ? { id: user.id } : new Response(null, { status: 401 }),
      ),
  );
async function request(
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  method = "POST",
) {
  return app.handle(
    new Request(`https://api.example.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
const web = { origin: "https://chat.example.test", "x-thechat-client": "web" };
const registration = await request("/auth/register", web, {
  name: "Browser",
  email,
  password: "password123",
});
const cookie = registration.headers.get("set-cookie")!.split(";")[0]!;
const headers = { ...web, cookie };
const id = crypto.randomUUID();
afterAll(async () => {
  await db.delete(users).where(eq(users.email, email));
  for (const [key, value] of [
    ["THECHAT_WEB_ORIGINS", saved.origins],
    ["BETTER_AUTH_URL", saved.backend],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
});

const routes = [
  ["/workspaces/create", "POST", 400],
  [`/workspaces/${id}/config/openrouter`, "PUT", 400],
  ["/conversations/dm", "POST", 400],
  [`/messages/${id}`, "POST", 400],
  ["/invites/create", "POST", 400],
  ["/bot-workspace-invites/accept", "POST", 400],
  ["/bots/create", "POST", 400],
  [`/bots/${id}/hermes`, "PATCH", 400],
  [`/bot-runtime/invocations/${id}/interactions/${id}`, "POST", 400],
  ["/attachments/", "POST", 400],
  ["/required", "GET", 200],
  ["/optional", "GET", 200],
] as const;
test("every protected surface rejects missing or forged CSRF context before authentication lookup", async () => {
  const lookup = spyOn(db, "select");
  try {
    for (const [path, method] of routes) {
      for (const unsafeHeaders of [
        { cookie },
        { cookie, "x-thechat-client": "web" },
        { ...headers, origin: "https://evil.example.test" },
        { ...headers, origin: "null" },
        { ...headers, "sec-fetch-site": "cross-site" },
      ] as Record<string, string>[]) {
        const response = await request(
          path,
          unsafeHeaders,
          method === "GET" ? undefined : {},
          method,
        );
        expect(response.status).toBe(403);
      }
    }
    expect(lookup).not.toHaveBeenCalled();
  } finally {
    lookup.mockRestore();
  }
});

test("valid PAT and bot bearer credentials are never accepted as browser cookies", async () => {
  const patResponse = await request("/auth/personal-access-tokens", headers, {
    name: "Cookie rejection fixture",
  });
  expect(patResponse.status).toBe(200);
  const pat = (await patResponse.json()) as any;
  const botResponse = await request("/bots/create", headers, {
    name: "Cookie rejection bot",
  });
  expect(botResponse.status).toBe(200);
  const bot = (await botResponse.json()) as any;
  try {
    for (const token of [pat.token, bot.apiKey]) {
      // Positive control proves the fixture is a real usable credential.
      expect(
        (
          await request(
            "/auth/me",
            { authorization: `Bearer ${token}` },
            undefined,
            "GET",
          )
        ).status,
      ).toBe(200);
      const forgedCookie = `__Host-thechat_session=${encodeURIComponent(token)}`;
      for (const path of [
        "/auth/me",
        "/workspaces/list",
        "/optional",
        "/required",
      ]) {
        expect(
          (
            await request(
              path,
              { ...web, cookie: forgedCookie },
              undefined,
              "GET",
            )
          ).status,
        ).toBe(401);
      }
      // Explicit web mode cannot fall back to a bearer header either.
      expect(
        (
          await request(
            "/auth/me",
            { ...web, authorization: `Bearer ${token}` },
            undefined,
            "GET",
          )
        ).status,
      ).toBe(401);
    }
  } finally {
    await request(`/bots/${bot.id}`, headers, undefined, "DELETE");
    await request(
      `/auth/personal-access-tokens/${pat.personalAccessToken.id}`,
      headers,
      undefined,
      "DELETE",
    );
  }
});

for (const [path, method, status] of routes) {
  test(`browser session reaches protected product route ${method} ${path}`, async () => {
    const response = await request(
      path,
      headers,
      method === "GET" ? undefined : { unexpected: true },
      method,
    );
    expect(response.status).toBe(status);
  });
}
