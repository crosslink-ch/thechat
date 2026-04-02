/**
 * MCP OAuth flow for connecting to MCP servers that require OAuth authentication.
 *
 * Implements the MCP OAuth spec directly:
 *  1. Discover OAuth protected resource metadata (RFC 9728)
 *  2. Discover authorization server metadata (RFC 8414)
 *  3. Dynamic client registration (RFC 7591)
 *  4. Authorization code flow with PKCE (RFC 7636)
 *
 * Uses a Rust-side local HTTP server (port 19876) to receive OAuth callbacks.
 */
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { info as logInfo, error as logError } from "../log";

// -- Types --

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
}

interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

interface ClientInfo {
  client_id: string;
  client_secret?: string;
}

interface OAuthTokens {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** Credentials stored per MCP server in the KV store. */
export interface McpOAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  clientSecret?: string;
  serverUrl: string;
  authServerUrl: string;
}

export type OAuthStatus =
  | { phase: "idle" }
  | { phase: "discovering" }
  | { phase: "registering" }
  | { phase: "authorizing"; url: string }
  | { phase: "waiting-callback" }
  | { phase: "exchanging" }
  | { phase: "saving" }
  | { phase: "done" }
  | { phase: "error"; message: string };

interface OAuthCallbackResult {
  code: string;
  state: string | null;
}

// -- PKCE --

const CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(43);
  crypto.getRandomValues(array);
  const verifier = Array.from(array, (b) => CHARSET[b % CHARSET.length]).join(
    "",
  );

  const encoded = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return { verifier, challenge };
}

function generateState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// -- KV storage --

function kvKey(serverName: string): string {
  return `mcp_oauth:${serverName}`;
}

export async function loadCredentials(
  serverName: string,
): Promise<McpOAuthCredentials | null> {
  const json = await invoke<string | null>("kv_get", {
    key: kvKey(serverName),
  });
  if (!json) return null;
  return JSON.parse(json);
}

async function saveCredentials(
  serverName: string,
  creds: McpOAuthCredentials,
): Promise<void> {
  await invoke("kv_set", {
    key: kvKey(serverName),
    value: JSON.stringify(creds),
  });
}

// -- Discovery --

async function discoverProtectedResource(
  serverUrl: string,
): Promise<ProtectedResourceMetadata | null> {
  const url = new URL(serverUrl);
  const wellKnown = `${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`;

  try {
    const res = await fetch(wellKnown);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function discoverAuthServer(
  authServerUrl: string,
): Promise<AuthServerMetadata | null> {
  // Try RFC 8414 first, then OIDC
  const urls = [
    `${authServerUrl}/.well-known/oauth-authorization-server`,
    `${authServerUrl}/.well-known/openid-configuration`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (data.authorization_endpoint && data.token_endpoint) {
        return data as AuthServerMetadata;
      }
    } catch {
      continue;
    }
  }

  return null;
}

// -- Dynamic Client Registration (RFC 7591) --

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<ClientInfo> {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: "TheChat",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Client registration failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    client_id: data.client_id,
    client_secret: data.client_secret,
  };
}

// -- Token Exchange --

async function exchangeCodeForTokens(
  tokenEndpoint: string,
  clientId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return await res.json();
}

// -- Build Authorization URL --

function buildAuthorizationUrl(
  authEndpoint: string,
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  state: string,
  scope?: string,
): string {
  const url = new URL(authEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (scope) url.searchParams.set("scope", scope);
  return url.toString();
}

// -- Main Flow --

/**
 * Run the full MCP OAuth flow for a server.
 *
 * @param serverName - Name to identify this MCP server in config
 * @param serverUrl - The MCP server's HTTP URL
 * @param onStatus - Called with status updates throughout the flow
 * @returns The OAuth credentials on success
 */
export async function runMcpOAuthFlow(
  serverName: string,
  serverUrl: string,
  onStatus: (status: OAuthStatus) => void,
): Promise<McpOAuthCredentials> {
  try {
    // 1. Start the local callback server
    const port: number = await invoke("mcp_oauth_start");
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    // 2. Discover OAuth metadata from the MCP server
    onStatus({ phase: "discovering" });
    logInfo(`[mcp-oauth] Discovering OAuth metadata for ${serverUrl}`);

    let authServerUrl: string;

    const resourceMeta = await discoverProtectedResource(serverUrl);
    if (resourceMeta?.authorization_servers?.[0]) {
      authServerUrl = resourceMeta.authorization_servers[0];
      logInfo(`[mcp-oauth] Found auth server: ${authServerUrl}`);
    } else {
      // Fall back to using the server's origin as the auth server
      authServerUrl = new URL(serverUrl).origin;
      logInfo(
        `[mcp-oauth] No protected resource metadata, using origin: ${authServerUrl}`,
      );
    }

    const authMeta = await discoverAuthServer(authServerUrl);
    if (!authMeta) {
      throw new Error(
        `Could not discover OAuth metadata for ${authServerUrl}. This server may not support OAuth.`,
      );
    }

    logInfo(
      `[mcp-oauth] Auth server metadata: authorization_endpoint=${authMeta.authorization_endpoint}, token_endpoint=${authMeta.token_endpoint}`,
    );

    // 3. Dynamic client registration
    onStatus({ phase: "registering" });

    let clientInfo: ClientInfo;
    if (authMeta.registration_endpoint) {
      logInfo(
        `[mcp-oauth] Registering client at ${authMeta.registration_endpoint}`,
      );
      clientInfo = await registerClient(
        authMeta.registration_endpoint,
        redirectUri,
      );
      logInfo(`[mcp-oauth] Client registered: ${clientInfo.client_id}`);
    } else {
      throw new Error(
        "OAuth server does not support dynamic client registration. A pre-registered client ID is required.",
      );
    }

    // 4. PKCE + authorization URL
    onStatus({ phase: "authorizing", url: "" });
    logInfo("[mcp-oauth] Generating PKCE and authorization URL");

    const pkce = await generatePKCE();
    const state = generateState();

    const authUrl = buildAuthorizationUrl(
      authMeta.authorization_endpoint,
      clientInfo.client_id,
      redirectUri,
      pkce.challenge,
      state,
    );

    onStatus({ phase: "authorizing", url: authUrl });

    // 5. Open browser
    logInfo(`[mcp-oauth] Opening browser for authorization`);
    await openUrl(authUrl);

    // 6. Wait for callback
    onStatus({ phase: "waiting-callback" });
    const callbackResult: OAuthCallbackResult =
      await invoke("mcp_oauth_await");

    // Verify state to prevent CSRF
    if (callbackResult.state && callbackResult.state !== state) {
      throw new Error("OAuth state mismatch — possible CSRF attack");
    }

    // 7. Exchange code for tokens
    onStatus({ phase: "exchanging" });
    logInfo("[mcp-oauth] Exchanging authorization code for tokens");

    const tokens = await exchangeCodeForTokens(
      authMeta.token_endpoint,
      clientInfo.client_id,
      callbackResult.code,
      pkce.verifier,
      redirectUri,
    );

    // 8. Save credentials
    onStatus({ phase: "saving" });

    const credentials: McpOAuthCredentials = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in
        ? Date.now() / 1000 + tokens.expires_in
        : undefined,
      clientId: clientInfo.client_id,
      clientSecret: clientInfo.client_secret,
      serverUrl,
      authServerUrl,
    };

    await saveCredentials(serverName, credentials);

    onStatus({ phase: "done" });
    logInfo(`[mcp-oauth] OAuth flow completed for ${serverName}`);

    return credentials;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logError(`[mcp-oauth] OAuth flow failed: ${message}`);
    onStatus({ phase: "error", message });

    // Clean up the callback server on error
    await invoke("mcp_oauth_cancel").catch(() => {});

    throw e;
  }
}

/**
 * Cancel an in-progress OAuth flow.
 */
export async function cancelMcpOAuthFlow(): Promise<void> {
  await invoke("mcp_oauth_cancel");
}
