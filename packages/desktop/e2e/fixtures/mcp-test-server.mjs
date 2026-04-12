#!/usr/bin/env node
//
// Minimal MCP server for E2E testing.
// Speaks JSON-RPC over stdio (newline-delimited).
// Provides a single tool: e2e_ping → returns "pong".

import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Notifications have no id — no response expected.
  if (msg.id === undefined || msg.id === null) return;

  switch (msg.method) {
    case "initialize":
      respond(msg.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "e2e-test-server", version: "1.0.0" },
      });
      break;

    case "tools/list":
      respond(msg.id, {
        tools: [
          {
            name: "e2e_ping",
            description: "Returns pong. Used for E2E testing.",
            inputSchema: {
              type: "object",
              properties: {
                message: {
                  type: "string",
                  description: "Optional message to echo back",
                },
              },
            },
          },
        ],
      });
      break;

    case "tools/call":
      respond(msg.id, {
        content: [{ type: "text", text: "pong" }],
      });
      break;

    default:
      respondError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
});

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n",
  );
}
