import { afterAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { eq, like } from "drizzle-orm";
import { db } from "../db";
import { users, verification } from "../db/schema";
const names = [
  "THECHAT_WEB_ORIGINS",
  "BETTER_AUTH_URL",
  "REQUIRE_EMAIL_VERIFICATION",
];
const saved = names.map((name) => process.env[name]);
process.env.THECHAT_WEB_ORIGINS = "https://chat.example.test";
process.env.BETTER_AUTH_URL = "https://api.example.test";
process.env.REQUIRE_EMAIL_VERIFICATION = "true";
const { authRoutes } = await import(".");
const {
  __setVerificationCodeSenderForTests,
  __setPasswordResetCodeSenderForTests,
  drainAuthenticationCodeDeliveries,
} = await import("./better-auth");
const codes = new Map<string, string>();
__setVerificationCodeSenderForTests(async (email, code) => {
  codes.set(email, code);
});
__setPasswordResetCodeSenderForTests(async (email, code) => {
  codes.set(email, code);
});
const emails: string[] = [];
const app = new Elysia().use(authRoutes);
const web = {
  origin: "https://chat.example.test",
  "x-thechat-client": "web",
  "content-type": "application/json",
};
async function request(
  path: string,
  body?: unknown,
  cookie?: string,
  method = "POST",
) {
  return app.handle(
    new Request(`https://api.example.test/auth/${path}`, {
      method,
      headers: { ...web, ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
afterAll(async () => {
  await drainAuthenticationCodeDeliveries();
  __setVerificationCodeSenderForTests(null);
  __setPasswordResetCodeSenderForTests(null);
  for (const email of emails) {
    await db
      .delete(verification)
      .where(like(verification.identifier, `%${email}%`));
    await db.delete(users).where(eq(users.email, email));
  }
  names.forEach((name, i) => {
    if (saved[i] === undefined) delete process.env[name];
    else process.env[name] = saved[i];
  });
});

test("browser verification mints only a cookie; password reset revokes it and requires fresh login", async () => {
  const email = `cookie-otp-${crypto.randomUUID()}@test.com`;
  emails.push(email);
  const signup = await request("register", {
    name: "Verified Browser",
    email,
    password: "password123",
  });
  expect(signup.status).toBe(200);
  expect(signup.headers.get("set-cookie")).toBeNull();
  expect(((await signup.json()) as any).accessToken).toBeUndefined();
  const verify = await request("verify-email", {
    email,
    code: codes.get(email),
  });
  expect(verify.status).toBe(200);
  expect(Object.keys(await verify.json())).toEqual(["user"]);
  const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
  expect(cookie).toStartWith("__Host-thechat_session=");
  expect((await request("me", undefined, cookie, "GET")).status).toBe(200);
  expect((await request("request-password-reset", { email })).status).toBe(200);
  await drainAuthenticationCodeDeliveries();
  const reset = await request("reset-password", {
    email,
    code: codes.get(email),
    password: "password456",
  });
  expect(reset.status).toBe(200);
  expect(reset.headers.get("set-cookie")).toBeNull();
  expect((await request("me", undefined, cookie, "GET")).status).toBe(401);
  const login = await request("login", { email, password: "password456" });
  expect(login.status).toBe(200);
  expect(Object.keys(await login.json())).toEqual(["user"]);
  expect(login.headers.get("set-cookie")).toContain("HttpOnly");
});
