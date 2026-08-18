# Personal access tokens

Personal access tokens (PATs) are named, non-expiring credentials for TheChat's REST API and Streamable HTTP MCP endpoint. A PAT acts as the human user who created it and has that user's full permissions. TheChat does not currently offer token scopes or OAuth-based API authorization.

## Create a token

1. Sign in to the desktop app with your human account.
2. Open **Settings** and scroll to **API access**.
3. Enter a descriptive name such as `Work laptop MCP` or `Release automation`.
4. Select **Create token**.
5. Copy the value beginning with `tchat_pat_` immediately.

The complete token is returned only once. TheChat stores a hash plus safe metadata; it cannot show the token again. Create a replacement if the value is lost.

PAT management is deliberately session-only. A PAT or bot token cannot create, list, or revoke personal access tokens.

## Store it securely

- Put the token in a password manager, operating-system keychain, or dedicated secret manager.
- Do not commit it to source control, paste it into chat, embed it in an image, or include it in application logs.
- Prefer an environment variable over a command-line argument, which may be retained in shell history or process listings.
- Restrict access to MCP client configuration files if the client stores headers as plain text.
- Treat suspected exposure as compromise and revoke the token immediately.

For a shell session, read the token without echoing it:

```sh
export THECHAT_API_URL="https://your-thechat-api.example.com"
read -rsp "TheChat personal access token: " THECHAT_TOKEN && printf '\n'
```

## REST example

The API accepts a PAT as a Bearer credential. This example retrieves the current user:

```sh
curl --request GET "${THECHAT_API_URL}/auth/me" \
  --header "Authorization: Bearer ${THECHAT_TOKEN}"
```

Use the same header for other REST endpoints. Never place the token in a URL or query string.

## MCP example

The MCP server uses Streamable HTTP at `${THECHAT_API_URL}/mcp`. Replace the placeholders in this common MCP client configuration shape:

```json
{
  "mcpServers": {
    "thechat": {
      "url": "https://your-thechat-api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_PERSONAL_ACCESS_TOKEN>"
      }
    }
  }
}
```

MCP tool calls pass through the same TheChat service authorization checks used by REST. Hermes bot management includes `create_hermes_bot`, `get_hermes_bot_config`, `update_hermes_bot_config`, `test_hermes_bot`, and `get_hermes_bot_capabilities`; workspace membership and bot ownership requirements still apply.

## Revoke a token

1. Return to **Settings → API access** using a signed-in session.
2. Find the token by its name and visible starting characters.
3. Select **Revoke**, then **Confirm revoke**.

Revocation takes effect for subsequent REST and MCP requests. Update or remove the credential from every client where it was stored. If a token is lost or may have leaked, revoke it rather than waiting: PATs do not expire automatically.
