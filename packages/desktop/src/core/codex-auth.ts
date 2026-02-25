import { fetch } from "@tauri-apps/plugin-http";

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const ISSUER = "https://auth.openai.com";

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export interface PKCECodes {
  verifier: string;
  challenge: string;
}

export interface DeviceAuthResponse {
  device_auth_id: string;
  user_code: string;
  interval: number;
}

export interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

interface DevicePollResult {
  authorization_code: string;
  code_verifier: string;
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

/** Start device authorization flow. Returns device_auth_id and user_code. */
export async function startDeviceAuth(): Promise<DeviceAuthResponse> {
  const pkce = await generatePKCE();

  const res = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    }),
  });

  if (!res.ok) {
    throw new Error(`Device auth failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return {
    device_auth_id: data.device_auth_id,
    user_code: data.user_code,
    interval: data.interval ?? 5,
  };
}

/**
 * Poll for device authorization completion.
 * Returns authorization_code + code_verifier once user completes browser auth.
 */
export async function pollDeviceAuth(
  deviceAuthId: string,
  userCode: string,
  signal?: AbortSignal,
): Promise<DevicePollResult> {
  const res = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      device_auth_id: deviceAuthId,
      user_code: userCode,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Poll failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return {
    authorization_code: data.authorization_code,
    code_verifier: data.code_verifier,
  };
}

/** Exchange authorization code for full token set. */
export async function exchangeCodeForTokens(
  authCode: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: authCode,
    redirect_uri: "http://localhost:1455/auth/callback",
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  }

  return res.json();
}

/** Refresh access token using refresh_token grant. */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  }

  return res.json();
}

/** Decode JWT claims (base64url decode the middle section). */
export function parseJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");

  const payload = parts[1]
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  const decoded = atob(padded);
  return JSON.parse(decoded);
}

/** Extract chatgpt_account_id from id_token or access_token claims. */
export function extractAccountId(tokens: TokenResponse): string {
  // Try id_token first
  try {
    const claims = parseJwtClaims(tokens.id_token);
    if (typeof claims.chatgpt_account_id === "string") {
      return claims.chatgpt_account_id;
    }
    // Fallback: first organization ID
    const orgs = claims.organizations as Array<{ id: string }> | undefined;
    if (orgs?.[0]?.id) return orgs[0].id;
  } catch {
    // Fall through to access_token
  }

  // Try access_token
  try {
    const claims = parseJwtClaims(tokens.access_token);
    if (typeof claims.chatgpt_account_id === "string") {
      return claims.chatgpt_account_id;
    }
    const orgs = claims.organizations as Array<{ id: string }> | undefined;
    if (orgs?.[0]?.id) return orgs[0].id;
  } catch {
    // No account ID found
  }

  return "";
}
