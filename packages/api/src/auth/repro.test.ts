import { describe, test, expect, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { authRoutes } from "./index";
import crypto from "crypto";

const app = new Elysia().use(authRoutes);

function uniqueEmail() {
  return `test-${crypto.randomUUID().slice(0, 8)}@test.com`;
}

const createdEmails: string[] = [];

afterAll(async () => {
  for (const email of createdEmails) {
    await db.delete(users).where(eq(users.email, email));
  }
});

async function post(path: string, body: unknown) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  const text = await response.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, body: json };
}

describe("Registration validation", () => {
  test("successful registration returns 200 with token and user", async () => {
    const email = uniqueEmail();
    createdEmails.push(email);
    const res = await post("/auth/register", {
      name: "Bruno",
      email,
      password: "uuuUuuuu5$",
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeString();
    expect(res.body.user.email).toBe(email);
  });

  test("rejects missing name", async () => {
    const res = await post("/auth/register", {
      email: "a@b.com",
      password: "password123",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test("rejects empty name", async () => {
    const res = await post("/auth/register", {
      name: "   ",
      email: "a@b.com",
      password: "password123",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Name");
  });

  test("rejects invalid email", async () => {
    const res = await post("/auth/register", {
      name: "Test",
      email: "not-an-email",
      password: "password123",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("email");
  });

  test("rejects short password", async () => {
    const res = await post("/auth/register", {
      name: "Test",
      email: "a@b.com",
      password: "short",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("8 characters");
  });

  test("rejects empty body", async () => {
    const res = await post("/auth/register", {});
    expect(res.status).toBe(400);
  });

  test("rejects no Content-Type", async () => {
    const response = await app.handle(
      new Request("http://localhost/auth/register", {
        method: "POST",
        body: JSON.stringify({ name: "X", email: "a@b.com", password: "12345678" }),
      })
    );
    expect(response.status).toBe(400);
  });
});

describe("Login validation", () => {
  test("valid credentials return 200", async () => {
    const email = uniqueEmail();
    createdEmails.push(email);
    await post("/auth/register", { name: "Login Test", email, password: "password123" });

    const res = await post("/auth/login", { email, password: "password123" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeString();
    expect(res.body.user.email).toBe(email);
  });

  test("wrong password returns 401", async () => {
    const email = uniqueEmail();
    createdEmails.push(email);
    await post("/auth/register", { name: "WP Test", email, password: "password123" });

    const res = await post("/auth/login", { email, password: "wrongpassword" });
    expect(res.status).toBe(401);
  });

  test("nonexistent email returns 401", async () => {
    const res = await post("/auth/login", {
      email: uniqueEmail(),
      password: "password123",
    });
    expect(res.status).toBe(401);
  });

  test("rejects invalid email", async () => {
    const res = await post("/auth/login", {
      email: "nope",
      password: "password123",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("email");
  });

  test("rejects missing password", async () => {
    const res = await post("/auth/login", {
      email: "a@b.com",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });
});
