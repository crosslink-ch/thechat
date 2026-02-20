import { describe, test, expect, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, sessions, emailVerifications } from "../db/schema";
import { authRoutes } from "./index";
import crypto from "crypto";

const app = new Elysia().use(authRoutes);

function uniqueEmail() {
  return `test-${crypto.randomUUID()}@test.com`;
}

const createdUserEmails: string[] = [];

async function cleanup() {
  for (const email of createdUserEmails) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (user) {
      // Cascade deletes handle sessions + verifications
      await db.delete(users).where(eq(users.id, user.id));
    }
  }
}

afterAll(cleanup);

async function req(
  method: string,
  path: string,
  body?: unknown,
  token?: string
) {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
  );

  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, body: json };
}

describe("Auth: Registration", () => {
  test("successful registration returns token and user", async () => {
    const email = uniqueEmail();
    createdUserEmails.push(email);

    const res = await req("POST", "/auth/register", {
      name: "Test User",
      email,
      password: "password123",
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toBeDefined();
    expect(res.body.user.name).toBe("Test User");
    expect(res.body.user.email).toBe(email);
  });

  test("duplicate email returns 409", async () => {
    const email = uniqueEmail();
    createdUserEmails.push(email);

    await req("POST", "/auth/register", {
      name: "First",
      email,
      password: "password123",
    });

    const res = await req("POST", "/auth/register", {
      name: "Second",
      email,
      password: "password456",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already");
  });

  test("missing fields return 422", async () => {
    const res = await req("POST", "/auth/register", {
      email: "bad",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("Auth: Login", () => {
  test("correct credentials return token and user", async () => {
    const email = uniqueEmail();
    createdUserEmails.push(email);

    await req("POST", "/auth/register", {
      name: "Login Test",
      email,
      password: "password123",
    });

    const res = await req("POST", "/auth/login", {
      email,
      password: "password123",
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe(email);
  });

  test("wrong password returns 401", async () => {
    const email = uniqueEmail();
    createdUserEmails.push(email);

    await req("POST", "/auth/register", {
      name: "Wrong PW",
      email,
      password: "password123",
    });

    const res = await req("POST", "/auth/login", {
      email,
      password: "wrongpassword",
    });

    expect(res.status).toBe(401);
  });

  test("nonexistent email returns 401", async () => {
    const res = await req("POST", "/auth/login", {
      email: uniqueEmail(),
      password: "password123",
    });

    expect(res.status).toBe(401);
  });
});

describe("Auth: Session (GET /auth/me)", () => {
  test("valid token returns user", async () => {
    const email = uniqueEmail();
    createdUserEmails.push(email);

    const reg = await req("POST", "/auth/register", {
      name: "Session Test",
      email,
      password: "password123",
    });

    const res = await req("GET", "/auth/me", undefined, reg.body.token);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
  });

  test("invalid token returns 401", async () => {
    const res = await req("GET", "/auth/me", undefined, "invalid-token");
    expect(res.status).toBe(401);
  });

  test("no token returns 401", async () => {
    const res = await req("GET", "/auth/me");
    expect(res.status).toBe(401);
  });
});

describe("Auth: Logout", () => {
  test("invalidates session", async () => {
    const email = uniqueEmail();
    createdUserEmails.push(email);

    const reg = await req("POST", "/auth/register", {
      name: "Logout Test",
      email,
      password: "password123",
    });

    const token = reg.body.token;

    // Logout
    const logoutRes = await req("POST", "/auth/logout", undefined, token);
    expect(logoutRes.status).toBe(200);

    // Session should be invalid now
    const meRes = await req("GET", "/auth/me", undefined, token);
    expect(meRes.status).toBe(401);
  });
});
