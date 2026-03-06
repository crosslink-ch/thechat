import { fetch } from "@tauri-apps/plugin-http";

export const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export interface PKCECodes {
  verifier: string;
  challenge: string;
}

export interface AnthropicTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

/** Generate PKCE verifier and S256 challenge. */
export async function generatePKCE(): Promise<PKCECodes> {
  const array = new Uint8Array(43);
  crypto.getRandomValues(array);
  const verifier = Array.from(array, (b) => CHARSET[b % CHARSET.length]).join("");

  const encoded = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return { verifier, challenge };
}

/** Build the Anthropic OAuth authorization URL for Claude Pro/Max. */
export function buildAuthUrl(pkce: PKCECodes): string {
  const url = new URL("https://claude.ai/oauth/authorize");
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", ANTHROPIC_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", "org:create_api_key user:profile user:inference");
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);
  return url.toString();
}

/**
 * Exchange the authorization code for tokens.
 * The code from the callback page may contain a `#state` suffix.
 */
export async function exchangeCode(
  code: string,
  verifier: string,
): Promise<AnthropicTokenResponse> {
  const splits = code.split("#");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1] ?? verifier,
      grant_type: "authorization_code",
      client_id: ANTHROPIC_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  }

  return res.json();
}

/** Refresh access token using refresh_token grant. */
export async function refreshAnthropicToken(
  refreshToken: string,
): Promise<AnthropicTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: ANTHROPIC_CLIENT_ID,
    }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  }

  return res.json();
}
