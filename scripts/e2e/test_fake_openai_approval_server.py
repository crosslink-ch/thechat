#!/usr/bin/env python3
"""Unit coverage for the deterministic approval-model fixture."""

from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "scripts/e2e/fake-openai-approval-server.py"


def load_server() -> Any:
    spec = importlib.util.spec_from_file_location("fake_openai_approval_server", SERVER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeOpenAIApprovalServerTests(unittest.TestCase):
    def setUp(self):
        self.server = load_server()
        self.trigger_payload = {
            "model": self.server.MODEL,
            "messages": [
                {
                    "role": "user",
                    "content": f"{self.server.TRIGGER_MARKER}: run it",
                }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {"name": "terminal", "parameters": {}},
                }
            ],
        }

    def test_first_triggered_completion_requests_the_terminal_tool(self):
        completion = self.server.completion_for(self.trigger_payload)
        choice = completion["choices"][0]
        self.assertEqual(choice["finish_reason"], "tool_calls")
        tool_call = choice["message"]["tool_calls"][0]
        self.assertEqual(tool_call["id"], self.server.TOOL_CALL_ID)
        self.assertEqual(tool_call["function"]["name"], "terminal")
        self.assertEqual(
            json.loads(tool_call["function"]["arguments"]),
            {"command": self.server.APPROVAL_COMMAND},
        )

    def test_tool_result_advances_to_final_message(self):
        payload = {
            **self.trigger_payload,
            "messages": [
                *self.trigger_payload["messages"],
                {
                    "role": "tool",
                    "tool_call_id": self.server.TOOL_CALL_ID,
                    "content": "hermes-approval-e2e-ok",
                },
            ],
        }
        completion = self.server.completion_for(payload)
        choice = completion["choices"][0]
        self.assertEqual(choice["finish_reason"], "stop")
        self.assertEqual(choice["message"]["content"], self.server.FINAL_MESSAGE)

    def test_denied_tool_result_cannot_fake_success(self):
        payload = {
            **self.trigger_payload,
            "messages": [
                *self.trigger_payload["messages"],
                {
                    "role": "tool",
                    "tool_call_id": self.server.TOOL_CALL_ID,
                    "content": '{"error":"Command denied"}',
                },
            ],
        }
        choice = self.server.completion_for(payload)["choices"][0]
        self.assertEqual(choice["finish_reason"], "tool_calls")
        self.assertNotEqual(choice["message"].get("content"), self.server.FINAL_MESSAGE)

    def test_streaming_completion_preserves_tool_call_and_finish_reason(self):
        chunks = self.server.stream_chunks_for(
            {
                **self.trigger_payload,
                "stream": True,
                "stream_options": {"include_usage": True},
            }
        )
        self.assertEqual(
            chunks[0]["choices"][0]["delta"]["tool_calls"][0]["id"],
            self.server.TOOL_CALL_ID,
        )
        self.assertEqual(chunks[1]["choices"][0]["finish_reason"], "tool_calls")
        self.assertEqual(chunks[2]["choices"], [])
        self.assertIn("usage", chunks[2])

    def test_auxiliary_call_without_terminal_tool_cannot_trigger_approval(self):
        payload = {
            "messages": [
                {"role": "user", "content": self.server.TRIGGER_MARKER},
            ],
            "tools": [],
        }
        completion = self.server.completion_for(payload)
        choice = completion["choices"][0]
        self.assertEqual(choice["finish_reason"], "stop")
        self.assertNotIn("tool_calls", choice["message"])


if __name__ == "__main__":
    unittest.main()
