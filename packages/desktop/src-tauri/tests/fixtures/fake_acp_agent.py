#!/usr/bin/env python3
"""Minimal stable ACP v1 stdio agent used by Rust integration tests."""

import json
import sys

PENDING = None


def send(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params", {})

    if method == "initialize":
        if "--hang-initialize" in sys.argv[1:]:
            with open(".fake-acp-initialize-received", "w", encoding="utf-8") as marker:
                marker.write("ready")
            continue
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": 1,
                    "agentCapabilities": {"loadSession": True},
                    "authMethods": [],
                    "agentInfo": {"name": "thechat-fake", "version": "1.0.0"},
                },
            }
        )
    elif method == "session/new":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"sessionId": "fake-session"},
            }
        )
    elif method == "session/load":
        if params.get("sessionId") != "fake-session":
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32001, "message": "unknown session"},
                }
            )
        else:
            send({"jsonrpc": "2.0", "id": request_id, "result": {}})
    elif method == "session/prompt":
        session_id = params["sessionId"]
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "hello from fake"},
                    },
                },
            }
        )
        PENDING = {"prompt_id": request_id, "session_id": session_id}
        send(
            {
                "jsonrpc": "2.0",
                "id": "permission-1",
                "method": "session/request_permission",
                "params": {
                    "sessionId": session_id,
                    "toolCall": {
                        "toolCallId": "tool-1",
                        "kind": "edit",
                        "title": "Edit a file",
                    },
                    "options": [
                        {
                            "optionId": "reject-once",
                            "name": "Reject",
                            "kind": "reject_once",
                        },
                        {
                            "optionId": "allow-once",
                            "name": "Allow",
                            "kind": "allow_once",
                        },
                        {
                            "optionId": "allow-always",
                            "name": "Always allow",
                            "kind": "allow_always",
                        },
                    ],
                },
            }
        )
    elif method == "session/cancel":
        if PENDING is not None:
            send(
                {
                    "jsonrpc": "2.0",
                    "id": PENDING["prompt_id"],
                    "result": {"stopReason": "cancelled"},
                }
            )
            PENDING = None
    elif request_id == "permission-1" and PENDING is not None:
        outcome = message.get("result", {}).get("outcome", {})
        if outcome.get("outcome") != "selected" or outcome.get("optionId") != "allow-once":
            print("client selected the wrong permission option", file=sys.stderr)
            sys.exit(23)
        send(
            {
                "jsonrpc": "2.0",
                "id": PENDING["prompt_id"],
                "result": {"stopReason": "end_turn"},
            }
        )
        PENDING = None
