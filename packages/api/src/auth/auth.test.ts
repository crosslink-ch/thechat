import { afterAll, describe, expect, spyOn, test } from "bun:test";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { account, bots, session, users } from "../db/schema";
import { auth } from "./better-auth";
import { authRoutes } from "./index";
import { resolveTokenToUser } from "./middleware";

const app = new Elysia().use(authRoutes);
const createdUserEmails: string[] = [];
const createdUserIds: string[] = [];

function uniqueEmail() {
  return `test-${crypto.randomUUID()}@test.com`;
}

afterAll(async () => {
  for (const email of createdUserEmails) {
    await db.delete(users).where(eq(users.email, email));
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

async function req(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep plain-text framework responses as-is.
  }
  return { status: response.status, body: parsed };
}

async function register(name = "Test User") {
  const email = uniqueEmail();
  createdUserEmails.push(email);
  const response = await req("POST", "/auth/register", {
    name,
    email,
    password: "password123",
  });
  return { email, response };
}

describe("Better Auth registration and login", () => {
  test("registration returns one opaque bearer token and stores the credential in account", async () => {
    const { email, response } = await register();

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeString();
    expect(response.body.accessToken.split(".")).not.toHaveLength(3);
    expect(response.body.refreshToken).toBeUndefined();
    expect(response.body.user).toMatchObject({ email, type: "human" });
    expect(response.body.user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const [credential] = await db
      .select({
        userId: account.userId,
        providerId: account.providerId,
        password: account.password,
      })
      .from(account)
      .where(eq(account.userId, response.body.user.id));
    expect(credential).toMatchObject({
      userId: response.body.user.id,
      providerId: "credential",
    });
    expect(credential.password).toBeString();
  });

  test("login returns one opaque bearer token", async () => {
    const { email } = await register("Login Test");
    const response = await req("POST", "/auth/login", {
      email,
      password: "password123",
    });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeString();
    expect(response.body.refreshToken).toBeUndefined();
    expect(response.body.user.email).toBe(email);
  });

  test("wrong-password and unknown-account failures are identical", async () => {
    const { email } = await register("Generic Login");
    const wrongPassword = await req("POST", "/auth/login", {
      email,
      password: "wrong-password",
    });
    const unknownAccount = await req("POST", "/auth/login", {
      email: uniqueEmail(),
      password: "wrong-password",
    });

    expect(wrongPassword).toEqual({
      status: 401,
      body: { error: "Invalid email or password" },
    });
    expect(unknownAccount).toEqual(wrongPassword);
  });

  test("duplicate registration is rejected", async () => {
    const { email } = await register("First Registration");
    const duplicate = await req("POST", "/auth/register", {
      name: "Duplicate Registration",
      email,
      password: "password456",
    });

    expect(duplicate.status).toBe(409);
  });
});

describe("Better Auth session facade", () => {
  test("/me resolves a live session and logout revokes it", async () => {
    const { email, response: registered } = await register("Session Test");
    const token = registered.body.accessToken;

    const me = await req("GET", "/auth/me", undefined, token);
    expect(me).toMatchObject({
      status: 200,
      body: { user: { email } },
    });

    const logout = await req("POST", "/auth/logout", {}, token);
    expect(logout).toEqual({ status: 200, body: { success: true } });
    expect((await req("GET", "/auth/me", undefined, token)).status).toBe(401);
    expect(
      await db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.userId, registered.body.user.id)),
    ).toHaveLength(0);
  });

  test("logout returns 503 when Better Auth reports success without revoking", async () => {
    const { response: registered } = await register("Failed Revocation");
    const token = registered.body.accessToken;
    const originalHandler = auth.handler.bind(auth);
    const handlerSpy = spyOn(auth, "handler").mockImplementation(
      async (request: Request) => {
        if (new URL(request.url).pathname === "/_better-auth/sign-out") {
          return Response.json({ success: true });
        }
        return originalHandler(request);
      },
    );

    try {
      expect(await req("POST", "/auth/logout", {}, token)).toEqual({
        status: 503,
        body: { error: "Authentication service temporarily unavailable" },
      });
      expect((await req("GET", "/auth/me", undefined, token)).status).toBe(200);
    } finally {
      handlerSpy.mockRestore();
    }
  });

  test("invalid and missing tokens return 401", async () => {
    expect((await req("GET", "/auth/me")).status).toBe(401);
    expect(
      (await req("GET", "/auth/me", undefined, "not-a-session-token")).status,
    ).toBe(401);
  });

  test("verification policy revokes a session created while verification was optional", async () => {
    const previous = process.env.REQUIRE_EMAIL_VERIFICATION;
    process.env.REQUIRE_EMAIL_VERIFICATION = "false";
    const { response: registered } = await register("Policy Test");
    try {
      process.env.REQUIRE_EMAIL_VERIFICATION = "true";
      expect(
        (await req("GET", "/auth/me", undefined, registered.body.accessToken))
          .status,
      ).toBe(401);
      expect(
        await db
          .select({ id: session.id })
          .from(session)
          .where(eq(session.userId, registered.body.user.id)),
      ).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.REQUIRE_EMAIL_VERIFICATION;
      else process.env.REQUIRE_EMAIL_VERIFICATION = previous;
    }
  });

  test("refresh and verify-session routes do not exist", async () => {
    expect((await req("POST", "/auth/refresh", {})).status).toBe(404);
    expect((await req("POST", "/auth/verify-session", {})).status).toBe(404);
  });
});

describe("bot API-key isolation", () => {
  test("bot_ keys use the bot table and can be excluded from human-only routes", async () => {
    const getSessionSpy = spyOn(auth.api, "getSession");
    const ownerEmail = uniqueEmail();
    createdUserEmails.push(ownerEmail);
    const [owner] = await db
      .insert(users)
      .values({ name: "Bot Owner", email: ownerEmail, type: "human" })
      .returning({ id: users.id });
    const [botUser] = await db
      .insert(users)
      .values({ name: "Auth Bot", type: "bot" })
      .returning({ id: users.id });
    createdUserIds.push(botUser.id);
    const apiKey = `bot_${crypto.randomUUID()}`;

    await db.insert(bots).values({
      userId: botUser.id,
      ownerId: owner.id,
      webhookSecret: "whsec_auth_test",
      apiKey,
    });

    expect(await resolveTokenToUser(apiKey)).toMatchObject({
      id: botUser.id,
      type: "bot",
    });
    expect(
      await resolveTokenToUser(apiKey, { includeBotTokens: false }),
    ).toBeNull();
    expect(await resolveTokenToUser("bot_not-a-real-key")).toBeNull();
    expect(getSessionSpy).not.toHaveBeenCalled();
    getSessionSpy.mockRestore();
  });
});
