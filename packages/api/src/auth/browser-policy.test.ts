import { afterAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { authRoutes } from ".";

const original = process.env.THECHAT_WEB_ORIGINS;
process.env.THECHAT_WEB_ORIGINS = "https://chat.example.test";
afterAll(() => {
  if (original === undefined) delete process.env.THECHAT_WEB_ORIGINS;
  else process.env.THECHAT_WEB_ORIGINS = original;
});
const app = new Elysia().use(authRoutes);

test("configured native dev origin is admitted only outside production", async () => {
  const config = await Bun.file(new URL("../../../desktop/src-tauri/tauri.conf.json", import.meta.url)).json();
  const origin = new URL(config.build.devUrl).origin;
  const previous = process.env.NODE_ENV;
  try {
    for (const environment of ["development", "production"]) {
      process.env.NODE_ENV = environment;
      const preflight = await app.handle(new Request("https://api.example.test/auth/login", {
        method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" },
      }));
      expect(preflight.headers.get("access-control-allow-origin")).toBe(environment === "development" ? origin : null);
      const login = await app.handle(new Request("https://api.example.test/auth/login", {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}",
      }));
      expect(login.status).toBe(environment === "development" ? 400 : 403);
      const protectedResponse = await app.handle(new Request("https://api.example.test/auth/me", { headers: { origin } }));
      expect(protectedResponse.status).toBe(environment === "development" ? 401 : 403);
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
});

test.each(["tauri://localhost", "https://chat.example.test"])("admits trace propagation from %s", async (origin) => {
  const response = await app.handle(new Request("https://api.example.test/auth/me", {
    method: "OPTIONS", headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "traceparent,tracestate,x-thechat-client" },
  }));
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  const allowed = response.headers.get("access-control-allow-headers")?.toLowerCase().split(/,\s*/);
  expect(allowed).toContain("traceparent");
  expect(allowed).toContain("tracestate");
});

test("credentialed CORS is available only to configured browser origins", async () => {
  const backend = process.env.BETTER_AUTH_URL;
  process.env.BETTER_AUTH_URL = "https://api.example.test";
  try {
    for (const origin of [
      "https://chat.example.test",
      "https://evil.example.test",
      "null",
    ]) {
      const response = await app.handle(
        new Request("https://api.example.test/auth/login", {
          method: "OPTIONS",
          headers: {
            origin,
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type,x-thechat-client",
          },
        }),
      );
      if (origin === "https://chat.example.test") {
        expect(response.headers.get("access-control-allow-origin")).toBe(
          origin,
        );
        expect(response.headers.get("access-control-allow-credentials")).toBe(
          "true",
        );
        expect(
          response.headers.get("access-control-allow-headers")?.toLowerCase(),
        ).toContain("x-thechat-client");
      } else {
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(
          response.headers.get("access-control-allow-credentials"),
        ).toBeNull();
      }
    }
  } finally {
    if (backend === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = backend;
  }
});

test("insecure browser sessions require explicit nonproduction loopback-only configuration", async () => {
  const names = [
    "BETTER_AUTH_URL",
    "THECHAT_WEB_ORIGINS",
    "THECHAT_WEB_ALLOW_INSECURE_LOOPBACK",
    "NODE_ENV",
  ];
  const saved = names.map((name) => process.env[name]);
  try {
    for (const [backend, origin, optIn, environment, expected] of [
      [
        "http://api.example.test",
        "https://chat.example.test",
        "true",
        "test",
        403,
      ],
      ["http://localhost:3000", "http://localhost:1420", "false", "test", 403],
      [
        "http://localhost:3000",
        "http://localhost:1420",
        "true",
        "production",
        403,
      ],
      [
        "http://localhost:3000",
        "http://chat.example.test",
        "true",
        "test",
        403,
      ],
      ["http://localhost:3000", "http://localhost:1420", "true", "test", 400],
    ] as const) {
      process.env.BETTER_AUTH_URL = backend;
      process.env.THECHAT_WEB_ORIGINS = origin;
      process.env.THECHAT_WEB_ALLOW_INSECURE_LOOPBACK = optIn;
      process.env.NODE_ENV = environment;
      const response = await app.handle(
        new Request(`${backend}/auth/register`, {
          method: "POST",
          headers: {
            origin,
            "x-thechat-client": "web",
            "x-forwarded-proto": "https",
            "x-forwarded-host": "localhost",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      expect(response.status).toBe(expected);
    }
  } finally {
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  }
});

test("browser auth rejects untrusted origins before parsing or effects", async () => {
  for (const path of [
    "register",
    "login",
    "verify-email",
    "resend-verification",
    "request-password-reset",
    "reset-password",
    "logout",
    "personal-access-tokens",
  ]) {
    for (const headers of [
      { origin: "https://evil.example.test", "x-thechat-client": "web" },
      { origin: "https://chat.example.test" },
      { "x-thechat-client": "web" },
      { origin: "null", "x-thechat-client": "web" },
      {
        origin: "https://chat.example.test",
        "x-thechat-client": "web",
        "sec-fetch-site": "cross-site",
      },
    ] as Record<string, string>[]) {
      const response = await app.handle(
        new Request(`https://api.example.test/auth/${path}`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(response.status).toBe(403);
    }
  }
});
