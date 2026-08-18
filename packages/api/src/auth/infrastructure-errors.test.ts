import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import {
  auth,
  BOT_API_KEY_CONFIG_ID,
  PERSONAL_ACCESS_TOKEN_CONFIG_ID,
  PERSONAL_ACCESS_TOKEN_PREFIX,
} from "./better-auth";
import { authRoutes } from "./index";
import { db } from "../db";
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

  test("bot API-key store outages do not become invalid credentials", async () => {
    const verifyApiKeySpy = spyOn(auth.api, "verifyApiKey").mockResolvedValue({
      valid: false,
      error: {
        code: "INVALID_API_KEY",
        message: "Invalid API key",
      },
    } as any);
    const executeSpy = spyOn(db, "execute").mockRejectedValue(
      new Error("simulated api-key store outage"),
    );

    try {
      const response = await json(
        await app.handle(
          new Request("http://localhost/auth/me", {
            headers: {
              authorization: `Bearer bot_${"a".repeat(64)}`,
            },
          }),
        ),
      );

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: "Authentication service temporarily unavailable",
      });
      expect(executeSpy).toHaveBeenCalledTimes(1);
    } finally {
      executeSpy.mockRestore();
      verifyApiKeySpy.mockRestore();
    }
  });

  test("personal access-token store outages do not become invalid credentials", async () => {
    const verifyApiKeySpy = spyOn(auth.api, "verifyApiKey").mockResolvedValue({
      valid: false,
      error: {
        code: "INVALID_API_KEY",
        message: "Invalid API key",
      },
    } as any);
    const executeSpy = spyOn(db, "execute").mockRejectedValue(
      new Error("simulated personal-token store outage"),
    );

    try {
      const response = await json(
        await app.handle(
          new Request("http://localhost/auth/me", {
            headers: {
              authorization: `Bearer ${PERSONAL_ACCESS_TOKEN_PREFIX}${"a".repeat(64)}`,
            },
          }),
        ),
      );

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: "Authentication service temporarily unavailable",
      });
      expect(executeSpy).toHaveBeenCalledTimes(1);
    } finally {
      executeSpy.mockRestore();
      verifyApiKeySpy.mockRestore();
    }
  });

  for (const credential of [
    {
      label: "bot API key",
      token: `bot_${"b".repeat(64)}`,
      configId: BOT_API_KEY_CONFIG_ID,
    },
    {
      label: "personal access token",
      token: `${PERSONAL_ACCESS_TOKEN_PREFIX}${"b".repeat(64)}`,
      configId: PERSONAL_ACCESS_TOKEN_CONFIG_ID,
    },
  ]) {
    test(`${credential.label} write failures remain retryable when the exact stored key is readable`, async () => {
      const verifyApiKeySpy = spyOn(auth.api, "verifyApiKey").mockResolvedValue({
        valid: false,
        error: {
          code: "INVALID_API_KEY",
          message: "Invalid API key",
        },
      } as any);
      const executeSpy = spyOn(db, "execute").mockResolvedValue([
        {
          id: crypto.randomUUID(),
          enabled: true,
          expiresAt: null,
        },
      ] as any);

      try {
        const response = await json(
          await app.handle(
            new Request("http://localhost/auth/me", {
              headers: { authorization: `Bearer ${credential.token}` },
            }),
          ),
        );

        expect(response.status).toBe(503);
        expect(response.body).toEqual({
          error: "Authentication service temporarily unavailable",
        });
        expect(executeSpy).toHaveBeenCalledTimes(1);
        const query = executeSpy.mock.calls[0]?.[0];
        expect(query).toBeDefined();
        const compiled = (db as any).dialect.sqlToQuery(query as any);
        expect(compiled.sql).toContain('"config_id" = $1');
        expect(compiled.sql).toContain('"key" = $2');
        expect(compiled.params[0]).toBe(credential.configId);
        expect(compiled.params[1]).not.toBe(credential.token);
      } finally {
        executeSpy.mockRestore();
        verifyApiKeySpy.mockRestore();
      }
    });
  }
});
