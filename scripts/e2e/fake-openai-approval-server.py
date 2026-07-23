#!/usr/bin/env python3
"""Deterministic OpenAI-compatible server for the Hermes approval UI E2E.

This is intentionally only a model fixture. The E2E still runs the real Hermes
Gateway, TheChat API/worker, and Tauri desktop application. The fixture forces
one harmless terminal call whose shell shape requires manual approval, then
returns a final response after Hermes reports the tool result.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MODEL = "hermes-approval-e2e"
TRIGGER_MARKER = "HERMES_DANGER_GATE_E2E"
TOOL_CALL_ID = "call_hermes_approval_ui_e2e"
APPROVAL_COMMAND = "printf 'echo hermes-approval-e2e-ok\\n' | sh"
FINAL_MESSAGE = "Hermes approval UI E2E completed after approval."


def _message_text(value: Any) -> str:
    """Flatten OpenAI message content enough to identify the E2E marker."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(_message_text(item) for item in value)
    if isinstance(value, dict):
        for key in ("text", "content", "value"):
            if key in value:
                return _message_text(value[key])
    return ""


def _terminal_is_offered(payload: dict[str, Any]) -> bool:
    for tool in payload.get("tools") or []:
        function = tool.get("function") if isinstance(tool, dict) else None
        if isinstance(function, dict) and function.get("name") == "terminal":
            return True
    return False


def _trigger_is_present(payload: dict[str, Any]) -> bool:
    return any(
        TRIGGER_MARKER in _message_text(message.get("content"))
        for message in payload.get("messages") or []
        if isinstance(message, dict)
    )


def _successful_tool_result_is_present(payload: dict[str, Any]) -> bool:
    return any(
        message.get("role") == "tool"
        and message.get("tool_call_id") == TOOL_CALL_ID
        and "hermes-approval-e2e-ok" in _message_text(message.get("content"))
        for message in payload.get("messages") or []
        if isinstance(message, dict)
    )


def completion_for(payload: dict[str, Any]) -> dict[str, Any]:
    """Build the deterministic chat-completion response for one request."""
    if _terminal_is_offered(payload) and _trigger_is_present(payload):
        if not _successful_tool_result_is_present(payload):
            message: dict[str, Any] = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": TOOL_CALL_ID,
                        "type": "function",
                        "function": {
                            "name": "terminal",
                            "arguments": json.dumps({"command": APPROVAL_COMMAND}),
                        },
                    }
                ],
            }
            finish_reason = "tool_calls"
        else:
            message = {"role": "assistant", "content": FINAL_MESSAGE}
            finish_reason = "stop"
    else:
        # Hermes can issue auxiliary calls (for example title generation). Do
        # not let those consume or duplicate the approval-driving tool call.
        message = {
            "role": "assistant",
            "content": "Hermes approval E2E auxiliary response.",
        }
        finish_reason = "stop"

    return {
        "id": f"chatcmpl-hermes-approval-e2e-{time.time_ns()}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": payload.get("model") or MODEL,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 10,
            "total_tokens": 20,
        },
    }


def stream_chunks_for(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Convert the deterministic completion into OpenAI streaming chunks."""
    completion = completion_for(payload)
    choice = completion["choices"][0]
    message = choice["message"]
    delta = {
        key: value
        for key, value in message.items()
        if key in {"role", "content", "tool_calls"}
    }
    base = {
        "id": completion["id"],
        "object": "chat.completion.chunk",
        "created": completion["created"],
        "model": completion["model"],
    }
    chunks = [
        {
            **base,
            "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
        },
        {
            **base,
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": choice["finish_reason"],
                }
            ],
        },
    ]
    if (payload.get("stream_options") or {}).get("include_usage"):
        chunks.append({**base, "choices": [], "usage": completion["usage"]})
    return chunks


class Handler(BaseHTTPRequestHandler):
    server_version = "HermesApprovalE2E/1.0"

    def _send_json(self, status: int, body: Any) -> None:
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _send_sse(self, chunks: list[dict[str, Any]]) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        for chunk in chunks:
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path == "/health":
            self._send_json(200, {"ok": True})
            return
        if self.path in {"/v1/models", f"/v1/models/{MODEL}"}:
            model = {"id": MODEL, "object": "model", "owned_by": "thechat-e2e"}
            self._send_json(
                200,
                {"object": "list", "data": [model]}
                if self.path.endswith("models")
                else model,
            )
            return
        self._send_json(404, {"error": {"message": f"Unknown E2E route: {self.path}"}})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path.rstrip("/") != "/v1/chat/completions":
            self._send_json(
                404, {"error": {"message": f"Unknown E2E route: {self.path}"}}
            )
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            if payload.get("stream"):
                self._send_sse(stream_chunks_for(payload))
            else:
                self._send_json(200, completion_for(payload))
        except Exception as exc:  # noqa: BLE001 - make fixture failures visible to the caller
            self._send_json(500, {"error": {"message": f"E2E fixture error: {exc}"}})

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - base class API
        print(
            f"[fake-openai] {self.address_string()} {format % args}",
            file=sys.stderr,
            flush=True,
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18081)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(
        f"fake OpenAI approval model listening on http://{args.host}:{args.port}/v1",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
