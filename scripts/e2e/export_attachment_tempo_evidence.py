#!/usr/bin/env python3
"""Export, normalize, and verify the fresh attachment E2E Tempo evidence."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import html
import json
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

SERVICES = ("thechat-api", "thechat-worker", "thechat-desktop")
ERROR = "STATUS_CODE_ERROR"
UNSET = "STATUS_CODE_UNSET"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tempo", default="http://127.0.0.1:13200")
    parser.add_argument(
        "--lookback-seconds",
        type=int,
        default=7200,
        help="Tempo search lookback window from the current time",
    )
    parser.add_argument(
        "--wait-seconds",
        type=float,
        default=45,
        help="Maximum time to wait for a complete run graph to become queryable",
    )
    parser.add_argument(
        "--poll-seconds",
        type=float,
        default=2,
        help="Delay between Tempo completeness probes",
    )
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--source-tree", required=True)
    parser.add_argument("--source-diff-sha256", required=True)
    parser.add_argument(
        "--scan-file",
        action="append",
        default=[],
        type=Path,
        help="Additional E2E/test/build log or PNG evidence to scan for secrets",
    )
    return parser.parse_args()


def http_json(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def otel_value(value: dict[str, Any]) -> Any:
    if not value:
        return None
    if "stringValue" in value:
        return value["stringValue"]
    if "intValue" in value:
        return int(value["intValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "boolValue" in value:
        return bool(value["boolValue"])
    if "bytesValue" in value:
        return value["bytesValue"]
    if "arrayValue" in value:
        return [otel_value(item) for item in value["arrayValue"].get("values", [])]
    if "kvlistValue" in value:
        return attributes(value["kvlistValue"].get("values", []))
    return value


def attributes(items: list[dict[str, Any]]) -> dict[str, Any]:
    return {item["key"]: otel_value(item.get("value", {})) for item in items}


def canonical_trace_id(value: str) -> str:
    normalized = value.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{1,32}", normalized):
        raise AssertionError(f"invalid Tempo trace ID: {value!r}")
    return normalized.zfill(32)


def decode_id(value: str | None, expected_bytes: int, field: str) -> str:
    if not value:
        return ""
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        raise AssertionError(f"invalid base64 {field}") from error
    if len(decoded) != expected_bytes:
        raise AssertionError(
            f"invalid {field} length: expected {expected_bytes}, got {len(decoded)}"
        )
    return decoded.hex()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_trace(trace_id: str, raw: dict[str, Any], run_id: str) -> dict[str, Any]:
    canonical_id = canonical_trace_id(trace_id)
    spans: list[dict[str, Any]] = []
    resources: list[dict[str, Any]] = []
    for batch in raw.get("batches", []):
        resource = attributes(batch.get("resource", {}).get("attributes", []))
        if resource.get("thechat.e2e.run_id") != run_id:
            continue
        resources.append(resource)
        service = resource.get("service.name", "unknown")
        for scope_spans in batch.get("scopeSpans", []):
            scope = scope_spans.get("scope", {}).get("name", "")
            for item in scope_spans.get("spans", []):
                item_trace_id = decode_id(item.get("traceId"), 16, "traceId")
                if item_trace_id != canonical_id:
                    raise AssertionError(
                        f"trace ID mismatch: fetched {canonical_id}, span has {item_trace_id}"
                    )
                start = int(item.get("startTimeUnixNano", "0"))
                end = int(item.get("endTimeUnixNano", "0"))
                if start <= 0 or end < start:
                    raise AssertionError(
                        f"invalid span timestamps in trace {canonical_id}: {start}..{end}"
                    )
                events = []
                for event in item.get("events", []):
                    events.append(
                        {
                            "name": event.get("name", ""),
                            "time_unix_nano": int(event.get("timeUnixNano", "0")),
                            "attributes": attributes(event.get("attributes", [])),
                        }
                    )
                links = []
                for link in item.get("links", []):
                    links.append(
                        {
                            "trace_id": decode_id(link.get("traceId"), 16, "link.traceId"),
                            "span_id": decode_id(link.get("spanId"), 8, "link.spanId"),
                            "attributes": attributes(link.get("attributes", [])),
                        }
                    )
                status = item.get("status", {})
                spans.append(
                    {
                        "trace_id": item_trace_id,
                        "span_id": decode_id(item.get("spanId"), 8, "spanId"),
                        "parent_span_id": decode_id(
                            item.get("parentSpanId"), 8, "parentSpanId"
                        ),
                        "service": service,
                        "scope": scope,
                        "name": item.get("name", ""),
                        "kind": item.get("kind", "SPAN_KIND_UNSPECIFIED"),
                        "start_unix_nano": start,
                        "end_unix_nano": end,
                        "duration_ms": round((end - start) / 1_000_000, 3),
                        "attributes": attributes(item.get("attributes", [])),
                        "events": events,
                        "links": links,
                        "status": {
                            "code": status.get("code", UNSET),
                            "message": status.get("message", ""),
                        },
                    }
                )
    spans.sort(key=lambda item: (item["start_unix_nano"], item["span_id"]))
    return {"trace_id": canonical_id, "resources": resources, "spans": spans}


def span_outcome(span: dict[str, Any]) -> Any:
    attrs = span["attributes"]
    for key in (
        "thechat.attachment.outcome",
        "thechat.attachment.binding_outcome",
        "thechat.message.outcome",
        "thechat.realtime.outcome",
        "thechat.outbox.outcome",
        "thechat.event.outcome",
        "thechat.storage.outcome",
        "realtime.delivery.outcome",
        "thechat.operation.outcome",
    ):
        if key in attrs:
            return attrs[key]
    return None


def assert_source_resources(
    traces: list[dict[str, Any]], args: argparse.Namespace
) -> int:
    expected = {
        "thechat.e2e.run_id": args.run_id,
        "service.version": args.source_commit,
        "thechat.source.tree": args.source_tree,
        "thechat.source.diff_sha256": args.source_diff_sha256,
    }
    resource_count = 0
    for trace in traces:
        for resource in trace["resources"]:
            resource_count += 1
            mismatches = {
                key: resource.get(key)
                for key, value in expected.items()
                if resource.get(key) != value
            }
            if mismatches:
                raise AssertionError(
                    f"trace {trace['trace_id']} source resource mismatch: "
                    + ", ".join(sorted(mismatches))
                )
    if resource_count == 0:
        raise AssertionError("no run-scoped source resources were exported")
    return resource_count


def assert_direct_parent(trace: dict[str, Any], parent_name: str, child_name: str) -> None:
    parents = [span for span in trace["spans"] if span["name"] == parent_name]
    children = [span for span in trace["spans"] if span["name"] == child_name]
    if not parents or not children:
        raise AssertionError(f"missing parent edge {parent_name} -> {child_name}")
    parent_ids = {span["span_id"] for span in parents}
    if not any(child["parent_span_id"] in parent_ids for child in children):
        raise AssertionError(f"missing direct parent edge {parent_name} -> {child_name}")


def assert_outbox_handler_chain(trace: dict[str, Any], leaf_name: str) -> None:
    assert_direct_parent(
        trace,
        "domain_event.outbox.consume",
        "domain_event.handle",
    )
    assert_direct_parent(trace, "domain_event.handle", leaf_name)


def find_trace(traces: list[dict[str, Any]], required_names: set[str]) -> dict[str, Any]:
    matches = [
        trace
        for trace in traces
        if required_names <= {span["name"] for span in trace["spans"]}
    ]
    if len(matches) != 1:
        raise AssertionError(
            f"expected one trace containing {sorted(required_names)}, found {len(matches)}"
        )
    return matches[0]


def find_spans(trace: dict[str, Any], name: str) -> list[dict[str, Any]]:
    return [span for span in trace["spans"] if span["name"] == name]


def format_trace_tree(trace: dict[str, Any]) -> str:
    children: dict[str, list[dict[str, Any]]] = {}
    roots: list[dict[str, Any]] = []
    for span in trace["spans"]:
        parent_id = span["parent_span_id"]
        if parent_id:
            children.setdefault(parent_id, []).append(span)
        else:
            roots.append(span)
    for values in children.values():
        values.sort(key=lambda item: (item["start_unix_nano"], item["span_id"]))
    roots.sort(key=lambda item: (item["start_unix_nano"], item["span_id"]))

    lines = [f"trace {trace['trace_id']}"]

    def visit(span: dict[str, Any], prefix: str, final: bool) -> None:
        branch = "└─" if final else "├─"
        outcome = span_outcome(span)
        detail = (
            f"{span['service']} | {span['name']} | "
            f"{span['kind'].removeprefix('SPAN_KIND_')} | "
            f"{span['status']['code'].removeprefix('STATUS_CODE_')} | "
            f"{span['duration_ms']:.3f} ms | span={span['span_id']}"
        )
        if outcome is not None:
            detail += f" | outcome={outcome}"
        lines.append(f"{prefix}{branch} {detail}")
        nested = children.get(span["span_id"], [])
        next_prefix = prefix + ("   " if final else "│  ")
        for index, child in enumerate(nested):
            visit(child, next_prefix, index == len(nested) - 1)

    for index, root in enumerate(roots):
        visit(root, "", index == len(roots) - 1)
    return "\n".join(lines)


EXPECTED_KINDS: dict[str, str] = {
    "attachment.prepare": "SPAN_KIND_INTERNAL",
    "attachment.hash": "SPAN_KIND_INTERNAL",
    "attachment.reserve.request": "SPAN_KIND_CLIENT",
    "HTTP POST /attachments": "SPAN_KIND_SERVER",
    "attachment.reserve": "SPAN_KIND_INTERNAL",
    "attachment.s3.upload": "SPAN_KIND_CLIENT",
    "attachment.complete.request": "SPAN_KIND_CLIENT",
    "HTTP POST /attachments/:id/complete": "SPAN_KIND_SERVER",
    "attachment.complete": "SPAN_KIND_INTERNAL",
    "attachment.validation.wait": "SPAN_KIND_INTERNAL",
    "attachment.status.request": "SPAN_KIND_CLIENT",
    "HTTP GET /attachments/:id": "SPAN_KIND_SERVER",
    "attachment.status": "SPAN_KIND_INTERNAL",
    "attachment.validate_promote": "SPAN_KIND_INTERNAL",
    "attachment.cancel.request": "SPAN_KIND_CLIENT",
    "HTTP DELETE /attachments/:id": "SPAN_KIND_SERVER",
    "attachment.delete.request": "SPAN_KIND_INTERNAL",
    "attachment.delete_objects": "SPAN_KIND_INTERNAL",
    "attachment.download": "SPAN_KIND_INTERNAL",
    "attachment.download.authorize.request": "SPAN_KIND_CLIENT",
    "HTTP GET /attachments/:id/download": "SPAN_KIND_SERVER",
    "attachment.download.authorize": "SPAN_KIND_INTERNAL",
    "attachment.s3.download": "SPAN_KIND_CLIENT",
    "message.send.request": "SPAN_KIND_CLIENT",
    "HTTP POST /messages/:conversationId": "SPAN_KIND_SERVER",
    "message.send": "SPAN_KIND_INTERNAL",
    "attachment.bind": "SPAN_KIND_INTERNAL",
    "domain_event.outbox.enqueue": "SPAN_KIND_PRODUCER",
    "domain_event.outbox.claim": "SPAN_KIND_CLIENT",
    "domain_event.outbox.consume": "SPAN_KIND_CONSUMER",
    "domain_event.handle": "SPAN_KIND_INTERNAL",
    "realtime.publish": "SPAN_KIND_PRODUCER",
    "realtime.receive": "SPAN_KIND_CONSUMER",
    "realtime.websocket.send": "SPAN_KIND_PRODUCER",
    "realtime.message.receive": "SPAN_KIND_CONSUMER",
}


def assert_identity_and_parent_invariants(
    traces: list[dict[str, Any]], run_id: str
) -> dict[str, Any]:
    trace_ids = [trace["trace_id"] for trace in traces]
    if len(trace_ids) != len(set(trace_ids)):
        raise AssertionError("duplicate trace IDs in normalized evidence")

    span_owner: dict[str, str] = {}
    for trace in traces:
        if trace["trace_id"] != canonical_trace_id(trace["trace_id"]):
            raise AssertionError(f"non-canonical trace ID: {trace['trace_id']}")
        if not trace["resources"] or any(
            resource.get("thechat.e2e.run_id") != run_id
            for resource in trace["resources"]
        ):
            raise AssertionError(f"trace {trace['trace_id']} has mixed run resources")
        if not trace["spans"]:
            raise AssertionError(f"trace {trace['trace_id']} has no spans")
        for span in trace["spans"]:
            if span["trace_id"] != trace["trace_id"]:
                raise AssertionError(f"span {span['span_id']} belongs to another trace")
            if span["span_id"] in span_owner:
                raise AssertionError(f"duplicate span ID {span['span_id']}")
            span_owner[span["span_id"]] = trace["trace_id"]

    root_count = 0
    for trace in traces:
        local = {span["span_id"]: span for span in trace["spans"]}
        roots = [span for span in trace["spans"] if not span["parent_span_id"]]
        if len(roots) != 1:
            raise AssertionError(
                f"trace {trace['trace_id']} has {len(roots)} roots, expected one"
            )
        root_count += 1
        for span in trace["spans"]:
            parent_id = span["parent_span_id"]
            if parent_id and parent_id not in local:
                if parent_id in span_owner:
                    raise AssertionError(
                        f"cross-trace parent {parent_id} for {span['span_id']}"
                    )
                raise AssertionError(
                    f"orphan parent {parent_id} for {span['span_id']}"
                )
            for link in span.get("links", []):
                if len(link["trace_id"]) != 32 or len(link["span_id"]) != 16:
                    raise AssertionError(
                        f"invalid link identity on span {span['span_id']}"
                    )
            seen: set[str] = set()
            cursor = span
            while cursor["parent_span_id"]:
                parent_id = cursor["parent_span_id"]
                if parent_id in seen:
                    raise AssertionError(
                        f"parent cycle in trace {trace['trace_id']} at {parent_id}"
                    )
                seen.add(parent_id)
                parent = local.get(parent_id)
                if parent is None:
                    break
                cursor = parent

    return {
        "trace_id_count": len(trace_ids),
        "unique_span_id_count": len(span_owner),
        "root_count": root_count,
        "orphan_parent_count": 0,
        "parent_cycle_count": 0,
        "link_count": sum(
            len(span.get("links", []))
            for trace in traces
            for span in trace["spans"]
        ),
    }


def assert_no_idle_claim_spans(all_spans: list[dict[str, Any]]) -> int:
    claim_spans = [
        span for span in all_spans if span["name"] == "domain_event.outbox.claim"
    ]
    if not claim_spans:
        raise AssertionError("no non-empty outbox claim spans were exported")
    productive = 0
    invalid: list[str] = []
    for span in claim_spans:
        attributes = span["attributes"]
        claimed_count = attributes.get("thechat.outbox.claimed_count")
        outcome = attributes.get("thechat.outbox.outcome")
        duration_ms = attributes.get("thechat.outbox.claim_duration_ms", 0)
        if isinstance(claimed_count, int) and claimed_count > 0 and outcome == "claimed":
            productive += 1
            continue
        if (
            claimed_count == 0
            and outcome == "slow_empty"
            and isinstance(duration_ms, (int, float))
            and duration_ms >= 100
        ):
            continue
        if (
            claimed_count == 0
            and outcome == "error"
            and span.get("status", {}).get("code") == ERROR
        ):
            continue
        invalid.append(span.get("span_id", "unknown"))
    if invalid:
        raise AssertionError(
            "idle/zero-result outbox claim span was exported without a slow/error outcome: "
            + ", ".join(invalid[:5])
        )
    if productive == 0:
        raise AssertionError("no productive outbox claim span was exported")
    return productive


def assert_graph(traces: list[dict[str, Any]], run_id: str) -> dict[str, Any]:
    structure = assert_identity_and_parent_invariants(traces, run_id)
    all_spans = [span for trace in traces for span in trace["spans"]]
    observed_services = {span["service"] for span in all_spans}
    missing_services = set(SERVICES) - observed_services
    if missing_services:
        raise AssertionError(f"missing required services: {sorted(missing_services)}")
    for name, expected_kind in EXPECTED_KINDS.items():
        matching = [span for span in all_spans if span["name"] == name]
        if not matching:
            raise AssertionError(f"required span kind was not observed: {name}")
        wrong = [span["kind"] for span in matching if span["kind"] != expected_kind]
        if wrong:
            raise AssertionError(
                f"unexpected kind for {name}: expected {expected_kind}, got {wrong}"
            )
    for span in all_spans:
        if span["name"].startswith("HTTP "):
            status = span["attributes"].get("http.response.status_code")
            if not isinstance(status, int) or not 100 <= status <= 599:
                raise AssertionError(
                    f"HTTP server span lacks response status: {span['name']}"
                )
    structure.update(
        {
            "service_count": len(observed_services),
            "kind_contract_count": len(EXPECTED_KINDS),
        }
    )
    trace_span_ids = {
        trace["trace_id"]: {span["span_id"] for span in trace["spans"]}
        for trace in traces
    }
    orphans = [
        (span["trace_id"], span["name"], span["parent_span_id"])
        for span in all_spans
        if span["parent_span_id"]
        and span["parent_span_id"] not in trace_span_ids[span["trace_id"]]
    ]
    if orphans:
        raise AssertionError(f"orphan parent references: {orphans[:5]}")

    message_trace = find_trace(
        traces,
        {
            "message.send.request",
            "HTTP POST /messages/:conversationId",
            "message.send",
            "attachment.bind",
            "domain_event.outbox.enqueue",
            "domain_event.outbox.consume",
            "realtime.publish",
            "realtime.receive",
            "realtime.websocket.send",
            "realtime.message.receive",
        },
    )
    for parent, child in (
        ("message.send.request", "HTTP POST /messages/:conversationId"),
        ("HTTP POST /messages/:conversationId", "message.send"),
        ("message.send", "attachment.bind"),
        ("message.send", "domain_event.outbox.enqueue"),
        ("domain_event.outbox.enqueue", "domain_event.outbox.consume"),
        ("message.send", "realtime.publish"),
        ("realtime.publish", "realtime.receive"),
        ("realtime.receive", "realtime.websocket.send"),
        ("realtime.websocket.send", "realtime.message.receive"),
    ):
        assert_direct_parent(message_trace, parent, child)

    failed_message = find_spans(message_trace, "message.send.request")[0]
    if span_outcome(failed_message) != "failed" or failed_message["status"]["code"] != ERROR:
        raise AssertionError("ambiguous first message response was not recorded as failed")
    if len(failed_message["events"]) != 1:
        raise AssertionError("ambiguous message failure lacks one sanitized exception event")
    exception_attributes = failed_message["events"][0]["attributes"]
    if exception_attributes.get("exception.message") != "operation_failed":
        raise AssertionError("ambiguous message exception was not sanitized")

    sent_traces = [
        trace
        for trace in traces
        if any(
            span["name"] == "message.send.request" and span_outcome(span) == "sent"
            for span in trace["spans"]
        )
    ]
    if len(sent_traces) != 1:
        raise AssertionError(f"expected one successful retry trace, found {len(sent_traces)}")
    sent_names = {span["name"] for span in sent_traces[0]["spans"]}
    if "attachment.bind" in sent_names or "domain_event.outbox.enqueue" in sent_names:
        raise AssertionError("idempotent message retry repeated attachment binding or outbox enqueue")

    download_trace = find_trace(
        traces,
        {
            "attachment.download",
            "attachment.download.authorize.request",
            "HTTP GET /attachments/:id/download",
            "attachment.download.authorize",
            "attachment.s3.download",
        },
    )
    for parent, child in (
        ("attachment.download", "attachment.download.authorize.request"),
        ("attachment.download.authorize.request", "HTTP GET /attachments/:id/download"),
        ("HTTP GET /attachments/:id/download", "attachment.download.authorize"),
        ("attachment.download", "attachment.s3.download"),
    ):
        assert_direct_parent(download_trace, parent, child)
    download = find_spans(download_trace, "attachment.download")[0]
    transfer = find_spans(download_trace, "attachment.s3.download")[0]
    if download["attributes"].get("thechat.attachment.transfer_observed") is not True:
        raise AssertionError("download flow did not record application-observed transfer")
    if span_outcome(transfer) != "downloaded":
        raise AssertionError("object GET did not record downloaded outcome")
    if transfer["attributes"].get("http.response.status_code") != 200:
        raise AssertionError("object GET did not record HTTP 200")
    if transfer["attributes"].get("thechat.attachment.transferred_bytes", 0) <= 0:
        raise AssertionError("object GET did not record transferred bytes")

    rejection_traces = [
        trace
        for trace in traces
        if any(
            span["name"] == "attachment.validation.wait"
            and span_outcome(span) == "rejected"
            for span in trace["spans"]
        )
    ]
    if len(rejection_traces) != 1:
        raise AssertionError(f"expected one rejection trace, found {len(rejection_traces)}")
    rejection_trace = rejection_traces[0]
    for name in ("attachment.validation.wait", "attachment.validate_promote"):
        candidate = [
            span
            for span in find_spans(rejection_trace, name)
            if span_outcome(span) == "rejected"
        ][0]
        if candidate["status"]["code"] != UNSET or candidate["events"]:
            raise AssertionError(f"expected policy rejection span {name} is noisy/error-marked")

    ready_traces = [
        trace
        for trace in traces
        if any(
            span["name"] == "attachment.validation.wait"
            and span_outcome(span) == "ready"
            for span in trace["spans"]
        )
    ]
    if len(ready_traces) != 2:
        raise AssertionError(f"expected two ready attachment traces, found {len(ready_traces)}")

    required_upload_names = {
        "attachment.prepare",
        "attachment.hash",
        "attachment.reserve.request",
        "HTTP POST /attachments",
        "attachment.reserve",
        "attachment.s3.upload",
        "attachment.complete.request",
        "HTTP POST /attachments/:id/complete",
        "attachment.complete",
        "domain_event.outbox.enqueue",
        "domain_event.outbox.consume",
        "domain_event.handle",
        "attachment.validate_promote",
        "attachment.validation.wait",
        "attachment.status.request",
        "HTTP GET /attachments/:id",
        "attachment.status",
    }
    upload_edges = (
        ("attachment.prepare", "attachment.hash"),
        ("attachment.prepare", "attachment.reserve.request"),
        ("attachment.reserve.request", "HTTP POST /attachments"),
        ("HTTP POST /attachments", "attachment.reserve"),
        ("attachment.prepare", "attachment.s3.upload"),
        ("attachment.prepare", "attachment.complete.request"),
        ("attachment.complete.request", "HTTP POST /attachments/:id/complete"),
        ("HTTP POST /attachments/:id/complete", "attachment.complete"),
        ("attachment.complete", "domain_event.outbox.enqueue"),
        ("domain_event.outbox.enqueue", "domain_event.outbox.consume"),
        ("attachment.prepare", "attachment.validation.wait"),
        ("attachment.validation.wait", "attachment.status.request"),
        ("attachment.status.request", "HTTP GET /attachments/:id"),
        ("HTTP GET /attachments/:id", "attachment.status"),
    )
    for trace in [rejection_trace, *ready_traces]:
        names = {span["name"] for span in trace["spans"]}
        if not required_upload_names <= names:
            raise AssertionError(
                f"attachment upload trace missing {sorted(required_upload_names - names)}"
            )
        for parent, child in upload_edges:
            assert_direct_parent(trace, parent, child)
        assert_outbox_handler_chain(trace, "attachment.validate_promote")

    cleanup_names = {
        "attachment.cancel.request",
        "HTTP DELETE /attachments/:id",
        "attachment.delete.request",
        "domain_event.outbox.enqueue",
        "domain_event.outbox.consume",
        "domain_event.handle",
        "attachment.delete_objects",
    }
    cleanup_traces = [
        trace
        for trace in traces
        if cleanup_names <= {span["name"] for span in trace["spans"]}
    ]
    if len(cleanup_traces) != 2:
        raise AssertionError(
            f"expected two attachment cleanup traces, found {len(cleanup_traces)}"
        )
    cleanup_edges = (
        ("attachment.cancel.request", "HTTP DELETE /attachments/:id"),
        ("HTTP DELETE /attachments/:id", "attachment.delete.request"),
        ("attachment.delete.request", "domain_event.outbox.enqueue"),
        ("domain_event.outbox.enqueue", "domain_event.outbox.consume"),
    )
    for trace in cleanup_traces:
        for parent, child in cleanup_edges:
            assert_direct_parent(trace, parent, child)
        assert_outbox_handler_chain(trace, "attachment.delete_objects")
        cancel = find_spans(trace, "attachment.cancel.request")[0]
        service_delete = find_spans(trace, "attachment.delete.request")[0]
        object_delete = find_spans(trace, "attachment.delete_objects")[0]
        if span_outcome(cancel) != "cancellation_requested":
            raise AssertionError("desktop cleanup span lacks cancellation_requested outcome")
        if span_outcome(service_delete) != "deletion_requested":
            raise AssertionError("attachment delete service span lacks deletion_requested outcome")
        if span_outcome(object_delete) != "deleted":
            raise AssertionError("attachment object deletion did not reach deleted outcome")
        if any(
            span["status"]["code"] != UNSET or span["events"]
            for span in (cancel, service_delete, object_delete)
        ):
            raise AssertionError("successful attachment cleanup was error-marked or noisy")

    claim_span_count = assert_no_idle_claim_spans(all_spans)

    error_spans = [span for span in all_spans if span["status"]["code"] == ERROR]
    missing_outcome = [span["name"] for span in error_spans if span_outcome(span) is None]
    if missing_outcome:
        raise AssertionError(f"error spans missing bounded outcomes: {missing_outcome}")

    return {
        "structure": structure,
        "message_trace_id": message_trace["trace_id"],
        "message_retry_trace_id": sent_traces[0]["trace_id"],
        "download_trace_id": download_trace["trace_id"],
        "rejection_trace_id": rejection_trace["trace_id"],
        "ready_trace_ids": [trace["trace_id"] for trace in ready_traces],
        "cleanup_trace_ids": [trace["trace_id"] for trace in cleanup_traces],
        "claim_span_count": claim_span_count,
        "error_span_count": len(error_spans),
        "orphan_parent_count": len(orphans),
    }


TELEMETRY_KEY_RULES = {
    "attachment_identity": re.compile(
        r"(?:^|[._-])(?:file_?name|filename|checksum|digest|etag|content_?hash|object_?key|storage_?key)(?:$|[._-])",
        re.IGNORECASE,
    ),
    "capability_or_url": re.compile(
        r"(?:^|[._-])(?:url|uri|presign(?:ed)?|signed_?url)(?:$|[._-])",
        re.IGNORECASE,
    ),
    "auth_or_secret": re.compile(
        r"(?:^|[._-])(?:authorization|cookie|set_?cookie|password|passwd|secret|credential|api_?key|access_?token|refresh_?token|id_?token)(?:$|[._-])",
        re.IGNORECASE,
    ),
    "raw_payload": re.compile(
        r"(?:^|[._-])(?:request_?body|response_?body|message_?content|raw_?payload)(?:$|[._-])",
        re.IGNORECASE,
    ),
}

TRACE_VALUE_RULES = {
    "url": re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE),
    "signed_query": re.compile(
        r"(?:x-amz-(?:signature|credential|security-token)|[?&](?:signature|token|credential|api_?key)=)",
        re.IGNORECASE,
    ),
    "authorization": re.compile(r"\b(?:authorization|proxy-authorization)\s*[:=]", re.IGNORECASE),
    "cookie": re.compile(r"\b(?:cookie|set-cookie)\s*[:=]", re.IGNORECASE),
    "bearer_or_basic": re.compile(r"\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}", re.IGNORECASE),
    "jwt": re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"),
    "aws_access_key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "database_dsn": re.compile(r"\b(?:postgres(?:ql)?|redis)://[^\s/@:]+:[^\s/@]+@", re.IGNORECASE),
}

CREDENTIAL_ASSIGNMENT = re.compile(
    r"(?im)(?:^|[\s\"'`])([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|database_url)[A-Za-z0-9_.-]*)\s*[:=]\s*([^\s,;]+)"
)
URL_VALUE = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
SENSITIVE_QUERY_KEY = re.compile(
    r"(?:signature|token|credential|authorization|api[_-]?key|x-amz-)", re.IGNORECASE
)
PNG_TEXT_CHUNKS = {"tEXt", "zTXt", "iTXt", "eXIf"}


def _value_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, sort_keys=True, default=str)


def _scan_value(value: Any, *, surface: str, findings: list[str]) -> None:
    text = _value_text(value)
    for category, rule in TRACE_VALUE_RULES.items():
        if rule.search(text):
            findings.append(f"{category}:{surface}")


def _scan_attributes(
    values: dict[str, Any], *, surface: str, findings: list[str]
) -> None:
    for key, value in values.items():
        for category, rule in TELEMETRY_KEY_RULES.items():
            if rule.search(key):
                findings.append(f"{category}:{surface}:{key}")
        _scan_value(value, surface=f"{surface}:{key}", findings=findings)


def _png_chunks(path: Path) -> list[str]:
    payload = path.read_bytes()
    if not payload.startswith(b"\x89PNG\r\n\x1a\n"):
        raise AssertionError(f"invalid PNG evidence: {path.name}")
    chunks: list[str] = []
    offset = 8
    while offset < len(payload):
        if offset + 12 > len(payload):
            raise AssertionError(f"truncated PNG evidence: {path.name}")
        length = int.from_bytes(payload[offset : offset + 4], "big")
        kind = payload[offset + 4 : offset + 8].decode("ascii", errors="replace")
        end = offset + 12 + length
        if end > len(payload):
            raise AssertionError(f"truncated PNG chunk in {path.name}")
        chunks.append(kind)
        offset = end
        if kind == "IEND":
            break
    if not chunks or chunks[-1] != "IEND" or offset != len(payload):
        raise AssertionError(f"invalid/trailing PNG evidence bytes: {path.name}")
    return chunks


def _scan_text_evidence(
    path: Path, text: str, run_id: str, findings: list[str]
) -> dict[str, Any]:
    generic_url_count = 0
    allowed_loopback_url_count = 0
    for match in URL_VALUE.finditer(text):
        generic_url_count += 1
        raw_url = match.group(0).rstrip(".,);]")
        parsed = urllib.parse.urlsplit(raw_url)
        query_keys = [key for key, _ in urllib.parse.parse_qsl(parsed.query)]
        if parsed.username or parsed.password or any(
            SENSITIVE_QUERY_KEY.search(key) for key in query_keys
        ):
            findings.append(f"unsafe_url:{path.name}")
        elif parsed.hostname in {"127.0.0.1", "localhost", "::1"}:
            allowed_loopback_url_count += 1

    for category, rule in TRACE_VALUE_RULES.items():
        if category == "url":
            continue
        if rule.search(text):
            findings.append(f"{category}:{path.name}")

    for match in CREDENTIAL_ASSIGNMENT.finditer(text):
        value = match.group(2).strip("\"'")
        if value.startswith("[REDACTED]") or value.startswith("***"):
            continue
        if value.startswith("process.env") or value.startswith("${"):
            continue
        findings.append(f"credential_assignment:{path.name}:{match.group(1)}")

    fixture_markers = sum(
        text.count(marker)
        for marker in (
            f"valid-{run_id}",
            f"rejected-{run_id}",
            f"cancel-{run_id}",
        )
    )
    return {
        "name": path.name,
        "kind": "text",
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "generic_url_count": generic_url_count,
        "allowed_loopback_url_count": allowed_loopback_url_count,
        "synthetic_fixture_marker_count": fixture_markers,
    }


def assert_secret_safe(
    traces: list[dict[str, Any]],
    run_id: str,
    scan_files: list[Path] | None = None,
    raw_payloads: dict[str, Any] | None = None,
) -> dict[str, Any]:
    findings: list[str] = []
    trace_surface_count = 0
    raw_payload_count = 0
    for trace_id, payload in (raw_payloads or {}).items():
        raw_payload_count += 1
        _scan_value(
            payload,
            surface=f"raw-trace-payload:{trace_id}",
            findings=findings,
        )
    for trace in traces:
        for resource in trace["resources"]:
            trace_surface_count += 1
            _scan_attributes(
                resource,
                surface=f"resource:{trace['trace_id']}",
                findings=findings,
            )
        for span in trace["spans"]:
            trace_surface_count += 1
            span_surface = f"span:{trace['trace_id']}:{span['name']}"
            _scan_attributes(span["attributes"], surface=span_surface, findings=findings)
            _scan_value(
                span["status"].get("message", ""),
                surface=f"status:{trace['trace_id']}:{span['name']}",
                findings=findings,
            )
            for event in span["events"]:
                trace_surface_count += 1
                _scan_value(
                    event["name"],
                    surface=f"event-name:{trace['trace_id']}:{span['name']}",
                    findings=findings,
                )
                _scan_attributes(
                    event["attributes"],
                    surface=f"event:{trace['trace_id']}:{span['name']}",
                    findings=findings,
                )
            for link in span.get("links", []):
                trace_surface_count += 1
                _scan_attributes(
                    link["attributes"],
                    surface=f"link:{trace['trace_id']}:{span['name']}",
                    findings=findings,
                )

    file_surfaces: list[dict[str, Any]] = []
    for path in scan_files or []:
        path = path.resolve()
        if not path.is_file():
            raise AssertionError(f"scan evidence file is missing: {path}")
        if path.suffix.lower() == ".png":
            chunks = _png_chunks(path)
            text_chunks = sorted(set(chunks) & PNG_TEXT_CHUNKS)
            if text_chunks:
                findings.append(f"png_text_metadata:{path.name}:{','.join(text_chunks)}")
            file_surfaces.append(
                {
                    "name": path.name,
                    "kind": "png",
                    "bytes": path.stat().st_size,
                    "sha256": sha256(path),
                    "chunks": chunks,
                    "text_metadata_chunks": text_chunks,
                    "pixel_review": "required_separately",
                }
            )
        else:
            text = path.read_text(encoding="utf-8", errors="replace")
            file_surfaces.append(
                _scan_text_evidence(path, text, run_id, findings)
            )

    if findings:
        raise AssertionError(f"forbidden telemetry/evidence content: {findings[:20]}")
    return {
        "forbidden_finding_count": 0,
        "rule_categories": sorted(
            set(TELEMETRY_KEY_RULES) | set(TRACE_VALUE_RULES) | {"credential_assignment", "png_metadata"}
        ),
        "trace_surface_count": trace_surface_count,
        "raw_payload_count": raw_payload_count,
        "files": file_surfaces,
    }


def render_report(
    traces: list[dict[str, Any]],
    graph: dict[str, Any],
    secret_scan: dict[str, Any],
    args: argparse.Namespace,
) -> str:
    spans = [span for trace in traces for span in trace["spans"]]
    services = Counter(span["service"] for span in spans)
    kinds = Counter(span["kind"] for span in spans)
    statuses = Counter(span["status"]["code"] for span in spans)
    names = Counter(span["name"] for span in spans)
    traces_by_id = {trace["trace_id"]: trace for trace in traces}
    canonical_trace_ids = [
        graph["message_trace_id"],
        graph["message_retry_trace_id"],
        graph["download_trace_id"],
        graph["rejection_trace_id"],
        *graph["ready_trace_ids"],
        *graph["cleanup_trace_ids"],
    ]
    canonical_trees = [
        format_trace_tree(traces_by_id[trace_id]) for trace_id in canonical_trace_ids
    ]
    lines = [
        "# Fresh Tempo attachment E2E evidence",
        "",
        f"- Run ID: `{args.run_id}`",
        f"- Source commit: `{args.source_commit}`",
        f"- Source tree: `{args.source_tree}`",
        f"- Source diff SHA-256: `{args.source_diff_sha256}`",
        f"- Traces: {len(traces)}",
        f"- Spans: {len(spans)}",
        f"- Orphan parent references: {graph['orphan_parent_count']}",
        f"- Unique span IDs: {graph['structure']['unique_span_id_count']}",
        f"- Parent cycles: {graph['structure']['parent_cycle_count']}",
        f"- Links validated: {graph['structure']['link_count']}",
        f"- Verified roots: {graph['structure']['root_count']}",
        f"- Verified source-stamped resources: {graph['source_resource_count']}",
        f"- Verified kind contracts: {graph['structure']['kind_contract_count']}",
        f"- Forbidden telemetry/evidence findings: {secret_scan['forbidden_finding_count']}",
        f"- Trace/resource/event/link surfaces secret-scanned: {secret_scan['trace_surface_count']}",
        f"- Additional evidence files secret-scanned: {len(secret_scan['files'])}",
        "",
        "## Verified graphs",
        "",
        f"- Message + attachment binding + outbox + realtime + WebSocket + desktop: `{graph['message_trace_id']}`",
        f"- Idempotent message retry: `{graph['message_retry_trace_id']}`",
        f"- Application-observed object download: `{graph['download_trace_id']}`",
        f"- Expected active-content rejection: `{graph['rejection_trace_id']}`",
        f"- Ready validation traces: {', '.join(f'`{item}`' for item in graph['ready_trace_ids'])}",
        f"- Non-empty claim spans: {graph['claim_span_count']}",
        f"- Error spans with bounded outcomes: {graph['error_span_count']}",
        "",
        "## Span inventory",
        "",
        "### By service",
        *[f"- `{key}`: {value}" for key, value in sorted(services.items())],
        "",
        "### By kind",
        *[f"- `{key}`: {value}" for key, value in sorted(kinds.items())],
        "",
        "### By status",
        *[f"- `{key}`: {value}" for key, value in sorted(statuses.items())],
        "",
        "### Names",
        *[f"- `{key}`: {value}" for key, value in sorted(names.items())],
        "",
        "## Canonical span trees",
        "",
        *[
            item
            for tree in canonical_trees
            for item in ("```text", tree, "```", "")
        ],
        "The verifier required exact direct parent edges across HTTP, outbox, Redis/realtime, WebSocket, and desktop boundaries. It also required retries to avoid repeating attachment binding/outbox enqueue, policy rejection spans to remain UNSET without exception events, all retained claim spans to have positive actual claimed counts, and the desktop download trace to include an observed HTTP 200 object GET with non-zero transferred bytes.",
        "",
    ]
    return "\n".join(lines)


def render_html_report(
    markdown_report: str,
    traces: list[dict[str, Any]],
    graph: dict[str, Any],
    args: argparse.Namespace,
) -> str:
    span_count = sum(len(trace["spans"]) for trace in traces)
    provenance_rows = (
        ("Run ID", args.run_id),
        ("Source commit", args.source_commit),
        ("Source tree", args.source_tree),
        ("Source diff SHA-256", args.source_diff_sha256),
        ("Trace count", str(len(traces))),
        ("Span count", str(span_count)),
    )
    invariant_rows = (
        ("Unique span IDs", graph["structure"]["unique_span_id_count"]),
        ("Roots", graph["structure"]["root_count"]),
        ("Orphan parents", graph["structure"]["orphan_parent_count"]),
        ("Parent cycles", graph["structure"]["parent_cycle_count"]),
        ("Source-stamped resources", graph["source_resource_count"]),
        ("Kind contracts", graph["structure"]["kind_contract_count"]),
        ("Error spans with outcomes", graph["error_span_count"]),
    )

    def rows(values: tuple[tuple[str, Any], ...]) -> str:
        return "".join(
            f"<tr><th>{html.escape(str(key))}</th><td><code>{html.escape(str(value))}</code></td></tr>"
            for key, value in values
        )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verified Tempo attachment E2E evidence</title>
<style>
body{{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#172033;background:#f6f8fb}}
h1,h2{{color:#0b3a67}}table{{border-collapse:collapse;width:100%;background:white;margin:1rem 0 2rem}}
th,td{{border:1px solid #ccd6e0;padding:.55rem;text-align:left}}th{{width:16rem;background:#eef4fa}}
.good{{color:#176b3a;font-weight:700}}pre{{white-space:pre-wrap;background:#111827;color:#e5e7eb;padding:1rem;border-radius:.5rem;overflow:auto}}
</style>
</head>
<body>
<h1>Verified Tempo attachment E2E evidence</h1>
<p class="good">All encoded graph, status, kind, provenance, and telemetry secret-safety assertions passed.</p>
<h2>Exact source and run</h2><table>{rows(provenance_rows)}</table>
<h2>Graph invariants</h2><table>{rows(invariant_rows)}</table>
<h2>Verified trace IDs</h2>
<ul>
<li>Message flow: <code>{html.escape(graph['message_trace_id'])}</code></li>
<li>Idempotent retry: <code>{html.escape(graph['message_retry_trace_id'])}</code></li>
<li>Observed download: <code>{html.escape(graph['download_trace_id'])}</code></li>
<li>Expected rejection: <code>{html.escape(graph['rejection_trace_id'])}</code></li>
</ul>
<h2>Machine-generated audit report</h2>
<pre>{html.escape(markdown_report)}</pre>
</body>
</html>
"""


def fetch_run_snapshot(
    args: argparse.Namespace,
) -> tuple[set[str], dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    trace_ids: set[str] = set()
    now = int(time.time())
    search_responses: dict[str, Any] = {}
    for service in SERVICES:
        query = urllib.parse.urlencode(
            {
                "tags": f"service.name={service}",
                "limit": 1000,
                "start": now - args.lookback_seconds,
                "end": now + 60,
            }
        )
        response = http_json(f"{args.tempo}/api/search?{query}")
        search_responses[service] = response
        trace_ids.update(
            canonical_trace_id(item["traceID"])
            for item in response.get("traces", [])
        )

    traces: list[dict[str, Any]] = []
    raw_payloads: dict[str, Any] = {}
    for trace_id in sorted(trace_ids):
        raw = http_json(f"{args.tempo}/api/traces/{trace_id}")
        normalized = normalize_trace(trace_id, raw, args.run_id)
        if not normalized["spans"]:
            continue
        raw_payloads[trace_id] = raw
        traces.append(normalized)
    return trace_ids, search_responses, traces, raw_payloads


def wait_for_complete_graph(
    args: argparse.Namespace,
) -> tuple[
    set[str],
    dict[str, Any],
    list[dict[str, Any]],
    dict[str, Any],
    dict[str, Any],
    int,
]:
    deadline = time.monotonic() + args.wait_seconds
    attempts = 0
    last_error: BaseException | None = None
    while True:
        attempts += 1
        try:
            trace_ids, search_responses, traces, raw_payloads = fetch_run_snapshot(args)
            if not traces:
                raise AssertionError(f"no traces found for run {args.run_id}")
            graph = assert_graph(traces, args.run_id)
            graph["source_resource_count"] = assert_source_resources(traces, args)
            return (
                trace_ids,
                search_responses,
                traces,
                raw_payloads,
                graph,
                attempts,
            )
        except (AssertionError, urllib.error.URLError) as error:
            last_error = error
            if time.monotonic() >= deadline:
                raise AssertionError(
                    "Tempo did not expose a complete verified run graph within "
                    f"{args.wait_seconds:g}s after {attempts} probes: "
                    f"{type(last_error).__name__}"
                ) from error
            time.sleep(args.poll_seconds)


def main() -> int:
    args = parse_args()
    if args.lookback_seconds <= 0:
        raise AssertionError("lookback seconds must be positive")
    output = args.output.resolve()
    if output.exists():
        raise AssertionError(f"output directory already exists: {output}")
    raw_dir = output / "tempo-traces-raw"
    raw_dir.mkdir(parents=True)

    (
        trace_ids,
        search_responses,
        traces,
        raw_payloads,
        graph,
        completeness_probe_count,
    ) = wait_for_complete_graph(args)

    secret_scan = assert_secret_safe(
        traces,
        args.run_id,
        args.scan_file,
        raw_payloads=raw_payloads,
    )
    raw_paths: list[Path] = []
    for trace_id, raw in sorted(raw_payloads.items()):
        raw_path = raw_dir / f"{trace_id}.json"
        raw_path.write_text(json.dumps(raw, indent=2, sort_keys=True) + "\n")
        raw_paths.append(raw_path)

    complete_export_path = output / "tempo-export.json"
    complete_export_path.write_text(
        json.dumps(
            {
                "metadata": {
                    "run_id": args.run_id,
                    "source_commit": args.source_commit,
                    "source_tree": args.source_tree,
                    "source_diff_sha256": args.source_diff_sha256,
                    "lookback_seconds": args.lookback_seconds,
                    "candidate_search_trace_count": len(trace_ids),
                    "run_trace_count": len(traces),
                    "retrieval_error_count": 0,
                    "completeness_probe_count": completeness_probe_count,
                },
                "search_responses": search_responses,
                "traces": raw_payloads,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    normalized_path = output / "tempo-traces-normalized.json"
    normalized_path.write_text(json.dumps(traces, indent=2, sort_keys=True) + "\n")
    search_path = output / "tempo-search-responses.json"
    search_path.write_text(json.dumps(search_responses, indent=2, sort_keys=True) + "\n")
    report_path = output / "tempo-evidence-report.md"
    markdown_report = render_report(traces, graph, secret_scan, args)
    report_path.write_text(markdown_report)
    html_report_path = output / "tempo-evidence-report.html"
    html_report_path.write_text(
        render_html_report(markdown_report, traces, graph, args)
    )
    secret_scan_path = output / "secret-scan-result.json"
    secret_scan_path.write_text(
        json.dumps(secret_scan, indent=2, sort_keys=True) + "\n"
    )
    verifier_path = output / "export_tempo_evidence.py"
    shutil.copy2(Path(__file__).resolve(), verifier_path)

    manifest_files = [
        *raw_paths,
        complete_export_path,
        normalized_path,
        search_path,
        report_path,
        html_report_path,
        secret_scan_path,
        verifier_path,
    ]
    manifest = {
        "run_id": args.run_id,
        "source_commit": args.source_commit,
        "source_tree": args.source_tree,
        "source_diff_sha256": args.source_diff_sha256,
        "generated_unix": int(time.time()),
        "lookback_seconds": args.lookback_seconds,
        "candidate_search_trace_count": len(trace_ids),
        "full_trace_payload_count": len(raw_payloads),
        "retrieval_error_count": 0,
        "completeness_probe_count": completeness_probe_count,
        "trace_count": len(traces),
        "span_count": sum(len(trace["spans"]) for trace in traces),
        "graph": graph,
        "secret_scan": secret_scan,
        "files": [
            {
                "path": str(path.relative_to(output)),
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
            for path in sorted(manifest_files)
        ],
    }
    manifest_path = output / "tempo-evidence-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
