import { sessionGeneration, expireBrowserSession } from "./session-boundary";
import { isWeb } from "../platform/environment";
import { treaty } from "@elysiajs/eden";
import type { App } from "@thechat/api";

export const API_URL = isWeb ? (__WEB_API_URL__ || window.location.origin) : __BACKEND_URL__;

/** Eden's transport hook, not a second API client. All routes stay Treaty-typed. */
const browserTransport = (async (input: RequestInfo | URL, options?: RequestInit) => {
  const generation = sessionGeneration();
  const headers = new Headers(options?.headers);
  headers.delete("authorization");
  headers.set("X-TheChat-Client", "web");
  const response = await globalThis.fetch(input, { ...options, headers, credentials: "include" });
  // Fence response-body parsing as well as response headers against account changes.
  await response.clone().arrayBuffer();
  if (generation !== sessionGeneration()) throw new DOMException("Session changed", "AbortError");
  const url = new URL(String(input), API_URL);
  const publicAuth = /\/auth\/(login|register|verify-email|request-password-reset|reset-password)$/.test(url.pathname);
  if (response.status === 401 && !publicAuth) expireBrowserSession(generation);
  return response;
}) as typeof fetch; // Bun adds a server-only preconnect member to the ambient DOM type.

export const api = treaty<App>(API_URL, isWeb ? {
  fetcher: browserTransport,
  fetch: { credentials: "include" },
  headers: { "X-TheChat-Client": "web" },
} : {});
