import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { auth } from "./better-auth";
import { authRoutes } from "./index";
import {
  authInfrastructureErrors,
  resolveTokenToUser,
} from "./middleware";

const app = new Elysia().use(authRoutes);
const outsideAuthRoutes = new Elysia().derive(async ({ headers }) => {
  const token = headers.authorization?.replace(/^Bearer /, "") ?? "";
  return { user: await resolveTokenToUser(token) };
}).get("/outside-auth", ({ user }) => ({ user }));
const protectedApp = new Elysia()
  .use(authInfrastructureErrors)
  .use(outsideAuthRoutes);
let getSessionSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  getSessionSpy?.mockRestore();
  getSessionSpy = null;
});

async function json(response: Response) {
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function failSessionLookup() {
  getSessionSpy = spyOn(auth.api, "getSession").mockRejectedValue(
    new Error("database connection unavailable"),
  );
}

describe("authentication infrastructure failures", () => {
  test("logout returns a sanitized retryable error instead of claiming revocation", async () => {
    failSessionLookup();

    const response = await json(
      await app.handle(
        new Request("http://localhost/auth/logout", {
          method: "POST",
          headers: {
            authorization: "Bearer opaque-session-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        }),
      ),
    );

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "Authentication service temporarily unavailable",
    });
  });

  test("authenticated routes do not collapse lookup outages into 401", async () => {
    failSessionLookup();

    const response = await json(
      await app.handle(
        new Request("http://localhost/auth/me", {
          headers: { authorization: "Bearer opaque-session-token" },
        }),
      ),
    );

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "Authentication service temporarily unavailable",
    });
  });

  test("routes outside /auth sanitize authentication-store outages", async () => {
    failSessionLookup();

    const response = await json(
      await protectedApp.handle(
        new Request("http://localhost/outside-auth", {
          headers: { authorization: "Bearer opaque-session-token" },
        }),
      ),
    );

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "Authentication service temporarily unavailable",
    });
    expect(JSON.stringify(response.body)).not.toContain(
      "database connection unavailable",
    );
  });
});
