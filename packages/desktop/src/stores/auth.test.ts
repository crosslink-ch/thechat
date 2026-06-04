import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { useAuthStore } from "./auth";

vi.mock("../lib/api", () => ({
  api: {
    auth: {
      register: { post: vi.fn() },
      login: { post: vi.fn() },
      "verify-email-otp": { post: vi.fn() },
    },
  },
}));

vi.mock("../lib/query-client", () => ({ queryClient: { clear: vi.fn() } }));

// Mirrors Eden Treaty's EdenFetchError shape returned in the `error` field.
function treatyError(status: number, value: unknown) {
  const err = new Error(String(value)) as Error & { status: number; value: unknown };
  err.status = status;
  err.value = value;
  return err;
}

describe("auth store error messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces the API message when registering with an existing email", async () => {
    vi.mocked(api.auth.register.post).mockResolvedValue({
      data: null,
      error: treatyError(409, { error: "An account with this email already exists" }),
    } as any);

    await expect(
      useAuthStore.getState().register("Jane", "jane@example.com", "password123"),
    ).rejects.toThrow("An account with this email already exists");
  });

  it("surfaces the API message for invalid login credentials", async () => {
    vi.mocked(api.auth.login.post).mockResolvedValue({
      data: null,
      error: treatyError(401, { error: "Invalid email or password" }),
    } as any);

    await expect(useAuthStore.getState().login("jane@example.com", "wrong")).rejects.toThrow(
      "Invalid email or password",
    );
  });

  it("reports an unreachable server instead of a raw fetch error", async () => {
    vi.mocked(api.auth.login.post).mockResolvedValue({
      data: null,
      error: treatyError(503, new TypeError("fetch failed")),
    } as any);

    await expect(useAuthStore.getState().login("jane@example.com", "password123")).rejects.toThrow(
      "Could not reach the server. Check your connection and try again.",
    );
  });

  it("surfaces verification errors from the API", async () => {
    vi.mocked(api.auth["verify-email-otp"].post).mockResolvedValue({
      data: null,
      error: treatyError(400, { error: "Invalid or expired verification code" }),
    } as any);

    await expect(
      useAuthStore.getState().verifyEmailOtp("jane@example.com", "123456"),
    ).rejects.toThrow("Invalid or expired verification code");
  });
});
