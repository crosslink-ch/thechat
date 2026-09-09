import { describe, expect, it } from "vitest";
import { edenErrorMessage } from "./eden";

// Mirrors Eden Treaty's EdenFetchError: HTTP errors carry the parsed response
// body in `value`; fetch-level failures carry the underlying Error instead.
function treatyError(status: number, value: unknown) {
  const err = new Error(String(value)) as Error & { status: number; value: unknown };
  err.status = status;
  err.value = value;
  return err;
}

describe("edenErrorMessage", () => {
  it("returns the API error message from the response body", () => {
    const error = treatyError(409, { error: "An account with this email already exists" });
    expect(edenErrorMessage(error, "Registration failed")).toBe(
      "An account with this email already exists",
    );
  });

  it("returns the API error message for 401 login failures", () => {
    const error = treatyError(401, { error: "Invalid email or password" });
    expect(edenErrorMessage(error, "Login failed")).toBe("Invalid email or password");
  });

  it("returns a friendly message when the server is unreachable", () => {
    const error = treatyError(503, new TypeError("fetch failed"));
    expect(edenErrorMessage(error, "Login failed")).toBe(
      "Could not reach the server. Check your connection and try again.",
    );
  });

  it("falls back when the body has no usable error message", () => {
    expect(edenErrorMessage(treatyError(500, { error: "  " }), "Login failed")).toBe(
      "Login failed",
    );
    expect(edenErrorMessage(treatyError(500, null), "Login failed")).toBe("Login failed");
    expect(edenErrorMessage(null, "Login failed")).toBe("Login failed");
  });

  it("reads error/message fields from plain error objects", () => {
    expect(edenErrorMessage({ error: "boom" }, "fallback")).toBe("boom");
    expect(edenErrorMessage({ message: "kaboom" }, "fallback")).toBe("kaboom");
  });
});
