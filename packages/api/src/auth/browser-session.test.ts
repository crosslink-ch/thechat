import { afterAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { authRoutes } from ".";

const saved = {
  origins: process.env.THECHAT_WEB_ORIGINS,
  backend: process.env.BETTER_AUTH_URL,
};
process.env.THECHAT_WEB_ORIGINS = "https://chat.example.test";
process.env.BETTER_AUTH_URL = "https://api.example.test";
const emails: string[] = [];
const app = new Elysia().use(authRoutes);
const webHeaders = {
  origin: "https://chat.example.test",
  "x-thechat-client": "web",
};
async function request(
  path: string,
  body?: unknown,
  headers: Record<string, string> = webHeaders,
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
afterAll(async () => {
  for (const email of emails)
    await db.delete(users).where(eq(users.email, email));
  for (const [key, value] of [
    ["THECHAT_WEB_ORIGINS", saved.origins],
    ["BETTER_AUTH_URL", saved.backend],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
});

test("same-origin browser GET can restore via exact trusted Referer and Fetch Metadata without Origin", async () => {
  const email = `cookie-get-${crypto.randomUUID()}@test.com`;
  emails.push(email);
  const registration = await request("/auth/register", {
    name: "Browser",
    email,
    password: "password123",
  });
  const cookie = registration.headers.get("set-cookie")!.split(";")[0]!;
  process.env.THECHAT_WEB_ORIGINS =
    "https://chat.example.test,https://api.example.test";
  try {
    const headers = {
      cookie,
      "x-thechat-client": "web",
      referer: "https://api.example.test/channels",
      "sec-fetch-site": "same-origin",
    };
    expect((await request("/auth/me", undefined, headers, "GET")).status).toBe(
      200,
    );
    expect(
      (await request("/auth/me", { name: "Forbidden" }, headers, "PATCH"))
        .status,
    ).toBe(403);
    expect(
      (
        await request(
          "/auth/me",
          undefined,
          { ...headers, referer: "https://evil.example.test/" },
          "GET",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          "/auth/me",
          undefined,
          { ...headers, "sec-fetch-site": "cross-site" },
          "GET",
        )
      ).status,
    ).toBe(403);
    expect(
      (await request("/auth/me", undefined, { cookie }, "GET")).status,
    ).toBe(403);
  } finally {
    process.env.THECHAT_WEB_ORIGINS = "https://chat.example.test";
  }
});

test("cookie session reload, profile mutation and logout use authoritative human sessions", async () => {
  const email = `cookie-lifecycle-${crypto.randomUUID()}@test.com`;
  emails.push(email);
  const registration = await request("/auth/register", {
    name: "Browser",
    email,
    password: "password123",
  });
  const cookie = registration.headers.get("set-cookie")!.split(";")[0]!;
  const headers = { ...webHeaders, cookie };
  const me = await request("/auth/me", undefined, headers, "GET");
  expect(me.status).toBe(200);
  expect(((await me.json()) as any).user.email).toBe(email);
  const update = await request(
    "/auth/me",
    { name: "Updated" },
    headers,
    "PATCH",
  );
  expect(update.status).toBe(200);
  expect(((await update.json()) as any).user.name).toBe("Updated");
  const logout = await request("/auth/logout", {}, headers);
  expect(logout.status).toBe(200);
  expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await request("/auth/me", undefined, headers, "GET")).status).toBe(
    401,
  );
});

test("web registration and login issue host-only HttpOnly Secure cookies without reusable tokens", async () => {
  const email = `cookie-${crypto.randomUUID()}@test.com`;
  emails.push(email);
  const body = { name: "Browser", email, password: "password123" };
  for (const path of ["/auth/register", "/auth/login"]) {
    const response = await request(path, body);
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json())).toEqual(["user"]);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toStartWith("__Host-thechat_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
    expect(response.headers.get("set-auth-token")).toBeNull();
  }
  const desktop = await request("/auth/login", body, {});
  expect(((await desktop.json()) as any).accessToken).toBeString();
  expect(desktop.headers.get("set-cookie")).toBeNull();
});
