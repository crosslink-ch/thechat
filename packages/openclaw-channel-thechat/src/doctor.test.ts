import { describe, test, expect } from "bun:test";
import { runDoctorChecks, type DoctorResult } from "./doctor.js";
import type { TheChatChannelConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validConfig: TheChatChannelConfig = {
  baseUrl: "https://chat.example.com",
  botId: "bot-1",
  botUserId: "user-bot-1",
  apiKey: "bot_testkey123",
  webhookSecret: "whsec_testsecret123",
};

function fakeFetchOk(status = 200): typeof fetch {
  return (async () =>
    new Response("{}", { status })) as unknown as typeof fetch;
}

function fakeFetchError(error: string): typeof fetch {
  return (async () => {
    throw new Error(error);
  }) as unknown as typeof fetch;
}

function findCheck(result: DoctorResult, name: string) {
  return result.checks.find((c) => c.name === name);
}

// ---------------------------------------------------------------------------
// Required fields check
// ---------------------------------------------------------------------------

describe("doctor — required_fields", () => {
  test("passes with all required fields", async () => {
    const result = await runDoctorChecks(validConfig, { fetchImpl: fakeFetchOk() });
    expect(findCheck(result, "required_fields")?.status).toBe("pass");
  });

  test("fails when apiKey is missing", async () => {
    const config = { ...validConfig, apiKey: "" };
    const result = await runDoctorChecks(config, { fetchImpl: fakeFetchOk() });
    const check = findCheck(result, "required_fields");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("apiKey");
  });

  test("fails when webhookSecret is missing", async () => {
    const config = { ...validConfig, webhookSecret: "" };
    const result = await runDoctorChecks(config, { fetchImpl: fakeFetchOk() });
    expect(findCheck(result, "required_fields")?.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// Base URL format
// ---------------------------------------------------------------------------

describe("doctor — base_url_format", () => {
  test("passes for https URL", async () => {
    const result = await runDoctorChecks(validConfig, { fetchImpl: fakeFetchOk() });
    expect(findCheck(result, "base_url_format")?.status).toBe("pass");
  });

  test("warns for http URL", async () => {
    const config = { ...validConfig, baseUrl: "http://chat.local" };
    const result = await runDoctorChecks(config, { fetchImpl: fakeFetchOk() });
    expect(findCheck(result, "base_url_format")?.status).toBe("warn");
  });

  test("fails for invalid URL", async () => {
    const config = { ...validConfig, baseUrl: "not a url" };
    const result = await runDoctorChecks(config, { fetchImpl: fakeFetchOk() });
    expect(findCheck(result, "base_url_format")?.status).toBe("fail");
  });

  test("skips when baseUrl is empty", async () => {
    const config = { ...validConfig, baseUrl: "" };
    const result = await runDoctorChecks(config, { fetchImpl: fakeFetchOk() });
    // required_fields will fail, but base_url_format should skip
    expect(findCheck(result, "base_url_format")?.status).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// Key format check
// ---------------------------------------------------------------------------

describe("doctor — key_formats", () => {
  test("passes when keys have correct prefixes", async () => {
    const result = await runDoctorChecks(validConfig, { fetchImpl: fakeFetchOk() });
    expect(findCheck(result, "key_formats")?.status).toBe("pass");
  });

  test("warns when apiKey lacks bot_ prefix", async () => {
    const config = { ...validConfig, apiKey: "sk_notabot" };
    const result = await runDoctorChecks(config, { fetchImpl: fakeFetchOk() });
    const check = findCheck(result, "key_formats");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("bot_");
  });

  test("warns when webhookSecret lacks whsec_ prefix", async () => {
    const config = { ...validConfig, webhookSecret: "secret_nope" };
    const result = await runDoctorChecks(config, { fetchImpl: fakeFetchOk() });
    const check = findCheck(result, "key_formats");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("whsec_");
  });
});

// ---------------------------------------------------------------------------
// Connectivity check
// ---------------------------------------------------------------------------

describe("doctor — connectivity", () => {
  test("passes when API is reachable", async () => {
    const result = await runDoctorChecks(validConfig, { fetchImpl: fakeFetchOk() });
    expect(findCheck(result, "connectivity")?.status).toBe("pass");
  });

  test("passes even with non-200 status (server is reachable)", async () => {
    const result = await runDoctorChecks(validConfig, { fetchImpl: fakeFetchOk(404) });
    expect(findCheck(result, "connectivity")?.status).toBe("pass");
  });

  test("fails when API is unreachable", async () => {
    const result = await runDoctorChecks(validConfig, {
      fetchImpl: fakeFetchError("ECONNREFUSED"),
    });
    expect(findCheck(result, "connectivity")?.status).toBe("fail");
    expect(findCheck(result, "connectivity")?.message).toContain("ECONNREFUSED");
  });

  test("skips when required fields are missing", async () => {
    const config = { ...validConfig, baseUrl: "" };
    const result = await runDoctorChecks(config, { fetchImpl: fakeFetchOk() });
    expect(findCheck(result, "connectivity")?.status).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// Bot credentials check
// ---------------------------------------------------------------------------

describe("doctor — bot_credentials", () => {
  test("passes when /auth/me returns 200", async () => {
    const calls: string[] = [];
    const impl: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    };
    const result = await runDoctorChecks(validConfig, { fetchImpl: impl });
    expect(findCheck(result, "bot_credentials")?.status).toBe("pass");
    // Should have called both / (connectivity) and /auth/me (credentials).
    expect(calls.some((u) => u.endsWith("/auth/me"))).toBe(true);
  });

  test("fails when /auth/me returns 401", async () => {
    let callCount = 0;
    const impl: typeof fetch = async () => {
      callCount++;
      // First call is connectivity (pass), second is credentials (401).
      if (callCount === 1) return new Response("{}", { status: 200 });
      return new Response("Unauthorized", { status: 401 });
    };
    const result = await runDoctorChecks(validConfig, { fetchImpl: impl });
    expect(findCheck(result, "bot_credentials")?.status).toBe("fail");
    expect(findCheck(result, "bot_credentials")?.message).toContain("401");
  });

  test("skips when connectivity fails", async () => {
    const result = await runDoctorChecks(validConfig, {
      fetchImpl: fakeFetchError("ECONNREFUSED"),
    });
    expect(findCheck(result, "bot_credentials")?.status).toBe("skip");
  });
});

// ---------------------------------------------------------------------------
// Top-level ok flag
// ---------------------------------------------------------------------------

describe("doctor — overall result", () => {
  test("ok is true when no check fails", async () => {
    const result = await runDoctorChecks(validConfig, { fetchImpl: fakeFetchOk() });
    expect(result.ok).toBe(true);
  });

  test("ok is false when any check fails", async () => {
    const config = { ...validConfig, apiKey: "" };
    const result = await runDoctorChecks(config, { fetchImpl: fakeFetchOk() });
    expect(result.ok).toBe(false);
  });

  test("ok is true even with warnings", async () => {
    const config = { ...validConfig, baseUrl: "http://chat.local" };
    const result = await runDoctorChecks(config, { fetchImpl: fakeFetchOk() });
    // http:// triggers a warning but not a failure.
    expect(result.ok).toBe(true);
  });
});
