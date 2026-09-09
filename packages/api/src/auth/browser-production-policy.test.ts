import { afterAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  browserAuthPolicy,
  browserSessionCookie,
  browserSessionToken,
} from "./browser";

// Characterize existing policy with the production host pair. No DB, mail,
// network listener or production credentials. This does not replace live E2E.
const web = "https://thechat.pranexa.com";
const api = "https://thechat-api.pranexa.com";
const saved = { ...process.env };
process.env.NODE_ENV = "production";
process.env.BETTER_AUTH_URL = api;
process.env.THECHAT_WEB_ORIGINS = web;
afterAll(() => {
  for (const key of ["NODE_ENV", "BETTER_AUTH_URL", "THECHAT_WEB_ORIGINS"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
const app = new Elysia().use(browserAuthPolicy)
  .get("/auth/me", ({ headers }) => ({ token: browserSessionToken(headers) }))
  .post("/auth/logout", () => ({ ok: true }));
const cookie = browserSessionCookie("synthetic-policy-fixture", web);

test("production same-site cross-origin cookie is host-only, Secure, HttpOnly and Lax", async () => {
  expect(cookie).toStartWith("__Host-thechat_session=");
  expect(cookie).toContain("Path=/; HttpOnly; Secure; SameSite=Lax;");
  expect(cookie.toLowerCase()).not.toContain("domain=");
  const response = await app.handle(new Request(`${api}/auth/me`, { headers: {
    origin: web, cookie, "x-thechat-client": "web", "sec-fetch-site": "same-site",
  } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ token: "synthetic-policy-fixture" });
  expect(response.headers.get("access-control-allow-origin")).toBe(web);
  expect(response.headers.get("access-control-allow-credentials")).toBe("true");
});

test("exact web preflight succeeds but suffix origin and cross-site requests fail", async () => {
  const preflight = await app.handle(new Request(`${api}/auth/me`, { method: "OPTIONS", headers: {
    origin: web, "access-control-request-method": "GET", "access-control-request-headers": "x-thechat-client",
  } }));
  expect(preflight.headers.get("access-control-allow-origin")).toBe(web);
  expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
  for (const [origin, site] of [[web + ".evil.test", "same-site"], [web, "cross-site"]]) {
    const response = await app.handle(new Request(`${api}/auth/me`, { headers: {
      origin, cookie, "x-thechat-client": "web", "sec-fetch-site": site,
    } }));
    expect(response.status).toBe(403);
  }
});

test("GET normalization restores only an explicitly trusted same-origin read", async () => {
  process.env.THECHAT_WEB_ORIGINS = `${web},${api}`;
  try {
    const headers = { cookie, "x-thechat-client": "web", "sec-fetch-site": "same-origin", referer: `${api}/app` };
    const response = await app.handle(new Request(`${api}/auth/me`, { headers }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: "synthetic-policy-fixture" });
    const mutation = await app.handle(new Request(`${api}/auth/logout`, { method: "POST", headers }));
    expect(mutation.status).toBe(403);
  } finally {
    process.env.THECHAT_WEB_ORIGINS = web;
  }
});

test("legacy packaged desktop bearer request is still admitted by browser policy", async () => {
  const response = await app.handle(new Request(`${api}/auth/me`, { headers: {
    origin: "tauri://localhost", authorization: "Bearer synthetic-native-fixture",
  } }));
  expect(response.status).toBe(200); // Policy admission only; not a real session.
  expect(await response.json()).toEqual({ token: null });
});
