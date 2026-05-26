export function authHeaders(token: string) {
  return {
    headers: {
      authorization: `Bearer ${token}`,
    },
  };
}

export function edenErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error) {
    const value = "value" in error ? (error as { value?: unknown }).value : error;
    if (typeof value === "object" && value && "error" in value) {
      const message = (value as { error?: unknown }).error;
      if (typeof message === "string" && message.trim()) return message;
    }
    if ("error" in error) {
      const message = (error as { error?: unknown }).error;
      if (typeof message === "string" && message.trim()) return message;
    }
    if ("message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  return fallback;
}
