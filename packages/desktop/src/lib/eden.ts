export function authHeaders(token: string) {
  return {
    headers: {
      authorization: `Bearer ${token}`,
    },
  };
}

export function edenErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error) {
    // Eden Treaty errors (EdenFetchError) carry the parsed response body in
    // `value`; for fetch-level failures (server down, DNS, CORS) the value is
    // the underlying Error instead of an API response body.
    const isTreatyError = "value" in error;
    const value = isTreatyError ? (error as { value?: unknown }).value : error;
    if (isTreatyError && value instanceof Error) {
      return "Could not reach the server. Check your connection and try again.";
    }
    if (typeof value === "object" && value && "error" in value) {
      const message = (value as { error?: unknown }).error;
      if (typeof message === "string" && message.trim()) return message;
    }
    // Plain-text error bodies (e.g. framework default 500s).
    if (isTreatyError && typeof value === "string" && value.trim()) return value;
    if ("error" in error) {
      const message = (error as { error?: unknown }).error;
      if (typeof message === "string" && message.trim()) return message;
    }
    // EdenFetchError.message is just String(body) ("[object Object]" for JSON
    // bodies), so only trust `message` on non-treaty errors.
    if (!isTreatyError && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  return fallback;
}
