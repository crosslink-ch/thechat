#!/usr/bin/env python3
from __future__ import annotations

import base64
import importlib.util
import tempfile
import unittest
from pathlib import Path
from typing import Any

MODULE_PATH = Path(__file__).with_name("export_attachment_tempo_evidence.py")


def load_module() -> Any:
    spec = importlib.util.spec_from_file_location("tempo_evidence_verifier", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TempoEvidenceVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.verifier = load_module()

    def test_trace_id_canonicalization_and_strict_protobuf_id_lengths(self) -> None:
        self.assertEqual(
            self.verifier.canonical_trace_id("abc"),
            "00000000000000000000000000000abc",
        )
        encoded = base64.b64encode(bytes.fromhex("11" * 16)).decode()
        self.assertEqual(
            self.verifier.decode_id(encoded, 16, "traceId"),
            "11" * 16,
        )
        with self.assertRaisesRegex(AssertionError, "length"):
            self.verifier.decode_id(encoded, 8, "spanId")

    def test_accepts_one_root_acyclic_run_scoped_trace(self) -> None:
        trace = self.trace(
            "11" * 16,
            [
                self.span("11" * 16, "aa" * 8, ""),
                self.span("11" * 16, "bb" * 8, "aa" * 8),
            ],
        )
        result = self.verifier.assert_identity_and_parent_invariants(
            [trace], "run-1"
        )
        self.assertEqual(result["root_count"], 1)
        self.assertEqual(result["orphan_parent_count"], 0)

    def test_rejects_duplicate_span_ids_across_traces(self) -> None:
        traces = [
            self.trace("11" * 16, [self.span("11" * 16, "aa" * 8, "")]),
            self.trace("22" * 16, [self.span("22" * 16, "aa" * 8, "")]),
        ]
        with self.assertRaisesRegex(AssertionError, "duplicate span ID"):
            self.verifier.assert_identity_and_parent_invariants(traces, "run-1")

    def test_rejects_parent_cycles_even_when_one_root_exists(self) -> None:
        trace_id = "11" * 16
        trace = self.trace(
            trace_id,
            [
                self.span(trace_id, "aa" * 8, ""),
                self.span(trace_id, "bb" * 8, "cc" * 8),
                self.span(trace_id, "cc" * 8, "bb" * 8),
            ],
        )
        with self.assertRaisesRegex(AssertionError, "parent cycle"):
            self.verifier.assert_identity_and_parent_invariants([trace], "run-1")

    def test_idle_claim_check_uses_actual_claimed_count(self) -> None:
        self.assertEqual(
            self.verifier.EXPECTED_KINDS["domain_event.outbox.claim"],
            "SPAN_KIND_CLIENT",
        )
        productive = {
            "name": "domain_event.outbox.claim",
            "span_id": "aa" * 8,
            "attributes": {
                "thechat.outbox.batch_size": 25,
                "thechat.outbox.claimed_count": 1,
                "thechat.outbox.claim_duration_ms": 4,
                "thechat.outbox.outcome": "claimed",
            },
            "status": {"code": self.verifier.UNSET},
        }
        self.assertEqual(
            self.verifier.assert_no_idle_claim_spans([productive]),
            1,
        )
        slow_empty = {
            "name": "domain_event.outbox.claim",
            "span_id": "bb" * 8,
            "attributes": {
                "thechat.outbox.batch_size": 25,
                "thechat.outbox.claimed_count": 0,
                "thechat.outbox.claim_duration_ms": 100,
                "thechat.outbox.outcome": "slow_empty",
            },
            "status": {"code": self.verifier.UNSET},
        }
        self.assertEqual(
            self.verifier.assert_no_idle_claim_spans([productive, slow_empty]),
            1,
        )
        idle = {
            "name": "domain_event.outbox.claim",
            "span_id": "cc" * 8,
            "attributes": {
                "thechat.outbox.batch_size": 25,
                "thechat.outbox.claimed_count": 0,
                "thechat.outbox.claim_duration_ms": 2,
                "thechat.outbox.outcome": "slow_empty",
            },
            "status": {"code": self.verifier.UNSET},
        }
        with self.assertRaisesRegex(AssertionError, "idle/zero-result"):
            self.verifier.assert_no_idle_claim_spans([productive, idle])

    def test_log_scan_accepts_redaction_and_rejects_plaintext_secret(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "e2e.log"
            path.write_text(
                "POSTGRES_PASSWORD=[REDACTED] http://127.0.0.1:3200/ready\n",
                encoding="utf-8",
            )
            result = self.verifier.assert_secret_safe([], "run-1", [path])
            self.assertEqual(result["forbidden_finding_count"], 0)
            self.assertEqual(result["files"][0]["allowed_loopback_url_count"], 1)

            path.write_text("POSTGRES_PASSWORD=plaintext\n", encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, "credential_assignment"):
                self.verifier.assert_secret_safe([], "run-1", [path])

    def test_source_resource_contract_rejects_mixed_source_identity(self) -> None:
        args = self.verifier.argparse.Namespace(
            run_id="run-1",
            source_commit="a" * 40,
            source_tree="b" * 40,
            source_diff_sha256="c" * 64,
        )
        trace = self.trace(
            "11" * 16,
            [self.span("11" * 16, "aa" * 8, "")],
        )
        trace["resources"][0].update(
            {
                "service.version": args.source_commit,
                "thechat.source.tree": args.source_tree,
                "thechat.source.diff_sha256": args.source_diff_sha256,
            }
        )
        self.assertEqual(self.verifier.assert_source_resources([trace], args), 1)
        trace["resources"][0]["thechat.source.tree"] = "d" * 40
        with self.assertRaisesRegex(AssertionError, "source resource mismatch"):
            self.verifier.assert_source_resources([trace], args)

    def test_trace_secret_scan_rejects_url_attributes(self) -> None:
        trace = {
            "trace_id": "11" * 16,
            "resources": [],
            "spans": [
                {
                    "name": "attachment.s3.download",
                    "attributes": {"url.full": "https://example.invalid/object"},
                    "status": {"message": ""},
                    "events": [],
                    "links": [],
                }
            ],
        }
        with self.assertRaisesRegex(AssertionError, "capability_or_url"):
            self.verifier.assert_secret_safe([trace], "run-1")

    def test_raw_trace_payload_scan_rejects_omitted_secret_surfaces(self) -> None:
        raw_payloads = {
            "11" * 16: {
                "batches": [
                    {
                        "scopeSpans": [
                            {
                                "scope": {
                                    "attributes": [
                                        {
                                            "key": "exporter.note",
                                            "value": {
                                                "stringValue": "https://example.invalid/object?token=secret"
                                            },
                                        }
                                    ]
                                }
                            }
                        ]
                    }
                ]
            }
        }
        with self.assertRaisesRegex(AssertionError, "url:raw-trace-payload"):
            self.verifier.assert_secret_safe(
                [], "run-1", raw_payloads=raw_payloads
            )

    @staticmethod
    def span(trace_id: str, span_id: str, parent_span_id: str) -> dict[str, Any]:
        return {
            "trace_id": trace_id,
            "span_id": span_id,
            "parent_span_id": parent_span_id,
        }

    @staticmethod
    def trace(
        trace_id: str, spans: list[dict[str, Any]]
    ) -> dict[str, Any]:
        return {
            "trace_id": trace_id,
            "resources": [
                {"thechat.e2e.run_id": "run-1", "service.name": "test"}
            ],
            "spans": spans,
        }


if __name__ == "__main__":
    unittest.main()
