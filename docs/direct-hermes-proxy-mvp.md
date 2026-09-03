# Direct Hermes proxy MVP

This experimental bot type proves that TheChat can proxy Hermes JSON-RPC without exposing the Hermes gateway credential to the desktop after setup.

## Try it

1. Run a Hermes dashboard/gateway that the **TheChat API process** can reach.
2. Copy its dashboard WebSocket session token.
3. In TheChat, open **Bots → Add bot**.
4. Select **Direct Hermes (JSON-RPC)**.
5. Enter a name, the Hermes dashboard base URL (or full `/api/ws` URL), and the session token.
6. Click the new bot under **Bots** in the workspace sidebar.

TheChat opens a direct conversation route, proxies one JSON-RPC request to Hermes, and displays the returned sessions:

```json
{
  "jsonrpc": "2.0",
  "method": "session.list",
  "params": { "limit": 200 }
}
```

The URL is normalized to `ws://…/api/ws` or `wss://…/api/ws`. The token is encrypted at rest with `THECHAT_SECRET_KEY`, falling back to `BETTER_AUTH_SECRET`, and is added to the WebSocket URL only inside the API process.

## Deliberate MVP limits

- `session.list` is the only supported Hermes RPC.
- Only the bot owner can request its session catalog.
- Direct Hermes bots do not receive channel mentions or chat messages.
- Connection settings cannot be edited yet; delete and recreate the bot.
- This uses Hermes dashboard session-token authentication. Hermes gateways configured for public browser login require a one-time WebSocket ticket instead, which this MVP does not implement.
