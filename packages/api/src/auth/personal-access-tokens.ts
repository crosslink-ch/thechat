import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  auth,
  betterAuthRequestURL,
  handleBetterAuthRequest,
  PERSONAL_ACCESS_TOKEN_CONFIG_ID,
} from "./better-auth";

export { PERSONAL_ACCESS_TOKEN_NAME_MAX_LENGTH } from "./better-auth";

export type PersonalAccessTokenMetadata = {
  id: string;
  name: string;
  start: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

type BetterAuthApiKey = {
  id?: unknown;
  configId?: unknown;
  name?: unknown;
  start?: unknown;
  createdAt?: unknown;
  lastRequest?: unknown;
  key?: unknown;
};

export class PersonalAccessTokenRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PersonalAccessTokenRequestError";
  }
}

function isoDate(value: unknown): string | null {
  if (!(typeof value === "string" || value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeMetadata(value: BetterAuthApiKey): PersonalAccessTokenMetadata {
  const createdAt = isoDate(value.createdAt);
  if (
    typeof value.id !== "string" ||
    value.configId !== PERSONAL_ACCESS_TOKEN_CONFIG_ID ||
    typeof value.name !== "string" ||
    !createdAt
  ) {
    throw new PersonalAccessTokenRequestError(
      503,
      "Personal access token service temporarily unavailable",
    );
  }

  return {
    id: value.id,
    name: value.name,
    start: typeof value.start === "string" ? value.start : null,
    createdAt,
    lastUsedAt: isoDate(value.lastRequest),
  };
}

function sessionHeaders(sessionToken: string, hasBody = false) {
  const headers = new Headers({ authorization: `Bearer ${sessionToken}` });
  if (hasBody) headers.set("content-type", "application/json");
  return headers;
}

async function callApiKeyEndpoint(
  method: "GET" | "POST",
  path: string,
  sessionToken: string,
  body?: unknown,
) {
  const { response } = await handleBetterAuthRequest(
    new Request(betterAuthRequestURL(path), {
      method,
      headers: sessionHeaders(sessionToken, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { ok: response.ok, status: response.status, data };
}

function apiFailure(status: number, action: "create" | "list" | "revoke") {
  if (status === 401 || status === 403) {
    return new PersonalAccessTokenRequestError(401, "Authentication required");
  }
  if (status === 404 && action === "revoke") {
    return new PersonalAccessTokenRequestError(
      404,
      "Personal access token not found",
    );
  }
  if (status >= 400 && status < 500) {
    return new PersonalAccessTokenRequestError(
      400,
      `Could not ${action} personal access token`,
    );
  }
  return new PersonalAccessTokenRequestError(
    503,
    "Personal access token service temporarily unavailable",
  );
}

export async function createPersonalAccessToken(
  sessionToken: string,
  name: string,
) {
  const result = await callApiKeyEndpoint(
    "POST",
    "/api-key/create",
    sessionToken,
    { configId: PERSONAL_ACCESS_TOKEN_CONFIG_ID, name },
  );
  if (!result.ok) throw apiFailure(result.status, "create");

  const value = result.data as BetterAuthApiKey | null;
  if (
    !value ||
    value.configId !== PERSONAL_ACCESS_TOKEN_CONFIG_ID ||
    typeof value.key !== "string"
  ) {
    throw apiFailure(503, "create");
  }

  return {
    token: value.key,
    personalAccessToken: safeMetadata(value),
  };
}

export async function listPersonalAccessTokens(sessionToken: string) {
  const query = new URLSearchParams({
    configId: PERSONAL_ACCESS_TOKEN_CONFIG_ID,
    sortBy: "createdAt",
    sortDirection: "desc",
  });
  const result = await callApiKeyEndpoint(
    "GET",
    `/api-key/list?${query.toString()}`,
    sessionToken,
  );
  if (!result.ok) throw apiFailure(result.status, "list");

  const value = result.data as { apiKeys?: unknown } | null;
  if (!value || !Array.isArray(value.apiKeys)) throw apiFailure(503, "list");
  return {
    personalAccessTokens: value.apiKeys.map((item) =>
      safeMetadata(item as BetterAuthApiKey),
    ),
  };
}

export async function revokePersonalAccessToken(
  sessionToken: string,
  tokenId: string,
) {
  const result = await callApiKeyEndpoint(
    "POST",
    "/api-key/delete",
    sessionToken,
    { configId: PERSONAL_ACCESS_TOKEN_CONFIG_ID, keyId: tokenId },
  );
  if (!result.ok) throw apiFailure(result.status, "revoke");
  return { success: true as const };
}

export async function verifyPersonalAccessToken(
  rawToken: string,
): Promise<string | null> {
  const result = await auth.api.verifyApiKey({
    body: {
      configId: PERSONAL_ACCESS_TOKEN_CONFIG_ID,
      key: rawToken,
    },
  });

  if (!result.valid || !result.key) {
    if (result.error?.code === "INVALID_API_KEY") {
      // Better Auth reports adapter failures and unknown credentials alike.
      // Probe the same store so an outage is surfaced as 503 by auth middleware.
      await db.execute(sql`select id from "apikey" limit 1`);
    }
    return null;
  }
  return result.key.referenceId;
}