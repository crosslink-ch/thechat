#!/usr/bin/env python3
"""Deterministic local OpenAI-compatible model for the real Hermes RPC E2E.

The fixture only replaces inference. The upstream agent loop, terminal tool,
JSON-RPC gateway, TheChat worker, and realtime bridge are all real processes.
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MODEL = "hermes-rpc-e2e"
TRIGGER = "HERMES_RPC_REAL_E2E"
TOOL_CALL_ID = "call_hermes_rpc_real_e2e"
TOOL_OUTPUT = "hermes-rpc-e2e-tool-ok"
FINAL_MESSAGE = "Hermes RPC real E2E completed after a genuine terminal tool call."

_LOCK = threading.Lock()
_STATE = {"requests": 0, "toolCalls": 0, "finals": 0}


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(_text(item) for item in value)
    if isinstance(value, dict):
        return "\n".join(_text(value.get(key)) for key in ("text", "content", "value"))
    return ""


def _completion(payload: dict[str, Any]) -> dict[str, Any]:
    messages = [item for item in payload.get("messages") or [] if isinstance(item, dict)]
    trigger_present = any(TRIGGER in _text(message.get("content")) for message in messages)
    tool_result_present = any(
        message.get("role") == "tool" and TOOL_OUTPUT in _text(message.get("content"))
        for message in messages
    )
    terminal_offered = any(
        isinstance(tool, dict)
        and isinstance(tool.get("function"), dict)
        and tool["function"].get("name") == "terminal"
        for tool in payload.get("tools") or []
    )

    if trigger_present and terminal_offered and not tool_result_present:
        message: dict[str, Any] = {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": TOOL_CALL_ID,
                    "type": "function",
                    "function": {
                        "name": "terminal",
                        "arguments": json.dumps({"command": f"printf {TOOL_OUTPUT}"}),
                    },
                }
            ],
        }
        finish_reason = "tool_calls"
        state_key = "toolCalls"
    elif trigger_present and tool_result_present:
        message = {"role": "assistant", "content": FINAL_MESSAGE}
        finish_reason = "stop"
        state_key = "finals"
    else:
        message = {"role": "assistant", "content": "Hermes RPC E2E auxiliary response."}
        finish_reason = "stop"
        state_key = None

    with _LOCK:
        _STATE["requests"] += 1
        if state_key:
            _STATE[state_key] += 1

    return {
        "id": f"chatcmpl-hermes-rpc-e2e-{time.time_ns()}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": payload.get("model") or MODEL,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
    }


def _chunks(completion: dict[str, Any]) -> list[dict[str, Any]]:
    choice = completion["choices"][0]
    message = choice["message"]
    base = {
        "id": completion["id"],
        "object": "chat.completion.chunk",
        "created": completion["created"],
        "model": completion["model"],
    }
    return [
        {
            **base,
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        key: value
                        for key, value in message.items()
                        if key in {"role", "content", "tool_calls"}
                    },
                    "finish_reason": None,
                }
            ],
        },
        {
            **base,
            "choices": [
                {"index": 0, "delta": {}, "finish_reason": choice["finish_reason"]}
            ],
        },
    ]


class Handler(BaseHTTPRequestHandler):
    server_version = "HermesRpcE2E/1.0"

    def _json(self, status: int, value: Any) -> None:
        encoded = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._json(200, {"ok": True})
        elif self.path == "/state":
            with _LOCK:
                self._json(200, dict(_STATE))
        elif self.path.rstrip("/") == "/v1/models":
            self._json(200, {"object": "list", "data": [{"id": MODEL, "object": "model"}]})
        else:
            self._json(404, {"error": {"message": "unknown route"}})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/v1/chat/completions":
            self._json(404, {"error": {"message": "unknown route"}})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            completion = _completion(payload)
            if payload.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                for chunk in _chunks(completion):
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                    self.wfile.flush()
                    time.sleep(0.15)
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            else:
                time.sleep(0.15)
                self._json(200, completion)
        except Exception as exc:  # noqa: BLE001
            self._json(500, {"error": {"message": f"fixture error: {exc}"}})

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Hermes RPC fake model ready on {args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
