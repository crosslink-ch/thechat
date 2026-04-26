import { describe, expect, it } from "vitest";
import {
  buildBrowserAuthUrl,
  CLIENT_ID,
  CODEX_BROWSER_REDIRECT_PATH,
  CODEX_OAUTH_SCOPE,
  CODEX_ORIGINATOR,
  ISSUER,
} from "./codex-auth";

describe("Codex browser auth", () => {
  it("builds an upstream-compatible browser OAuth URL", () => {
    const redirectUri = `http://localhost:1455${CODEX_BROWSER_REDIRECT_PATH}`;
    const authUrl = buildBrowserAuthUrl(
      redirectUri,
      { verifier: "verifier", challenge: "challenge" },
      "state-123",
    );

    const url = new URL(authUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/oauth/authorize`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("scope")).toBe(CODEX_OAUTH_SCOPE);
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("originator")).toBe(CODEX_ORIGINATOR);
    expect(url.searchParams.get("state")).toBe("state-123");
  });
});
