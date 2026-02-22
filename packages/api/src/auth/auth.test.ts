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
  test("successful registration returns accessToken, refreshToken, and user", async () => {
    const email = uniqueEmail();
    createdUserEmails.push(email);

    const res = await req("POST", "/auth/register", {
      name: "Test User",
      email,
      password: "password123",
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.user).toBeDefined();
    expect(res.body.user.name).toBe("Test User");
    expect(res.body.user.email).toBe(email);

    // accessToken should be a JWT (3 dot-separated segments)
    expect(res.body.accessToken.split(".").length).toBe(3);
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
  test("correct credentials return accessToken, refreshToken, and user", async () => {
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
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
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

    const res = await req("GET", "/auth/me", undefined, reg.body.accessToken);

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
  test("invalidates refresh token", async () => {
    const email = uniqueEmail();
    createdUserEmails.push(email);

    const reg = await req("POST", "/auth/register", {
      name: "Logout Test",
      email,
      password: "password123",
    });

    const accessToken = reg.body.accessToken;
    const refreshToken = reg.body.refreshToken;

    // Logout — sends refresh token in body
    const logoutRes = await req(
      "POST",
      "/auth/logout",
      { refreshToken },
      accessToken
    );
    expect(logoutRes.status).toBe(200);

    // JWT access token still works (stateless — valid until expiry)
    const meRes = await req("GET", "/auth/me", undefined, accessToken);
    expect(meRes.status).toBe(200);

    // But refresh token is invalidated — cannot get new access tokens
    const refreshRes = await req("POST", "/auth/refresh", { refreshToken });
    expect(refreshRes.status).toBe(401);
  });
});

describe("Auth: Refresh", () => {
  test("returns new access token for valid refresh token", async () => {
    const email = uniqueEmail();
    createdUserEmails.push(email);

    const reg = await req("POST", "/auth/register", {
      name: "Refresh Test",
      email,
      password: "password123",
    });

    const res = await req("POST", "/auth/refresh", {
      refreshToken: reg.body.refreshToken,
    });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.accessToken.split(".").length).toBe(3);

    // New access token should work for /me
    const meRes = await req("GET", "/auth/me", undefined, res.body.accessToken);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.email).toBe(email);
  });

  test("invalid refresh token returns 401", async () => {
    const res = await req("POST", "/auth/refresh", {
      refreshToken: "invalid-refresh-token",
    });
    expect(res.status).toBe(401);
  });

  test("refresh after logout fails", async () => {
    const email = uniqueEmail();
    createdUserEmails.push(email);

    const reg = await req("POST", "/auth/register", {
      name: "Refresh After Logout",
      email,
      password: "password123",
    });

    // Logout
    await req(
      "POST",
      "/auth/logout",
      { refreshToken: reg.body.refreshToken },
      reg.body.accessToken
    );

    // Refresh should fail
    const res = await req("POST", "/auth/refresh", {
      refreshToken: reg.body.refreshToken,
    });
    expect(res.status).toBe(401);
  });
});

describe("Auth: Verify Session", () => {
  test("valid refresh token returns valid: true", async () => {
    const email = uniqueEmail();
    createdUserEmails.push(email);

    const reg = await req("POST", "/auth/register", {
      name: "Verify Session Test",
      email,
      password: "password123",
    });

    const res = await req("POST", "/auth/verify-session", {
      refreshToken: reg.body.refreshToken,
    });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  test("invalid refresh token returns 401", async () => {
    const res = await req("POST", "/auth/verify-session", {
      refreshToken: "invalid-token",
    });
    expect(res.status).toBe(401);
  });

  test("returns 401 after logout", async () => {
    const email = uniqueEmail();
    createdUserEmails.push(email);

    const reg = await req("POST", "/auth/register", {
      name: "Verify After Logout",
      email,
      password: "password123",
    });

    // Logout invalidates the session
    await req(
      "POST",
      "/auth/logout",
      { refreshToken: reg.body.refreshToken },
      reg.body.accessToken
    );

    const res = await req("POST", "/auth/verify-session", {
      refreshToken: reg.body.refreshToken,
    });
    expect(res.status).toBe(401);
  });
});
