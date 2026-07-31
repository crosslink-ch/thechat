#!/usr/bin/env python3
"""Policy-boundary tests for TheChat attachment CloudFormation templates."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent
PRODUCTION_TEMPLATE = ROOT / "cloudformation-production.yaml"
DEVELOPMENT_TEMPLATE = ROOT / "cloudformation.yaml"
REPOSITORY = ROOT.parents[2]
TAURI_CONFIG = REPOSITORY / "packages/desktop/src-tauri/tauri.conf.json"
OBJECT_STORE_SOURCE = REPOSITORY / "packages/api/src/attachments/s3-object-store.ts"
WORKFLOW = REPOSITORY / ".github/workflows/helm-chart.yml"
RUNBOOK = ROOT / "PRODUCTION.md"
CANARY = ROOT / "canary.sh"


class CloudFormationLoader(yaml.SafeLoader):
    """Preserve CloudFormation short-form tags as structured values."""


def construct_cloudformation_tag(
    loader: CloudFormationLoader,
    tag_suffix: str,
    node: yaml.Node,
) -> dict[str, Any]:
    if isinstance(node, yaml.ScalarNode):
        value: Any = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node)
    elif isinstance(node, yaml.MappingNode):
        value = loader.construct_mapping(node)
    else:
        raise TypeError(f"Unsupported YAML node: {type(node).__name__}")
    return {tag_suffix: value}


CloudFormationLoader.add_multi_constructor("!", construct_cloudformation_tag)


def load_template(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as source:
        document = yaml.load(source, Loader=CloudFormationLoader)
    if not isinstance(document, dict):
        raise AssertionError(f"Expected mapping in {path}")
    return document


def actions(statement: dict[str, Any]) -> set[str]:
    value = statement["Action"]
    return {value} if isinstance(value, str) else set(value)


def sub_value(resource: Any) -> str:
    if not isinstance(resource, dict) or set(resource) != {"Sub"}:
        raise AssertionError(f"Expected !Sub resource, got {resource!r}")
    value = resource["Sub"]
    if not isinstance(value, str):
        raise AssertionError(f"Expected scalar !Sub, got {value!r}")
    return value


def statements(resource: dict[str, Any]) -> dict[str, dict[str, Any]]:
    document = resource["Properties"]["PolicyDocument"]
    return {statement["Sid"]: statement for statement in document["Statement"]}


class ProductionAttachmentTemplateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.template = load_template(PRODUCTION_TEMPLATE)
        cls.resources = cls.template["Resources"]
        cls.source = PRODUCTION_TEMPLATE.read_text(encoding="utf-8")

    def test_retains_users_without_embedding_or_creating_credentials(self) -> None:
        resource_types = [resource["Type"] for resource in self.resources.values()]

        self.assertEqual(resource_types.count("AWS::IAM::User"), 2)
        self.assertEqual(resource_types.count("AWS::IAM::Policy"), 2)
        self.assertNotIn("AWS::IAM::AccessKey", resource_types)
        self.assertNotIn("AWS::IAM::Role", resource_types)
        self.assertNotIn("AKIA", self.source)
        self.assertNotIn("ASIA", self.source)

        for name in ("AttachmentApiUser", "AttachmentWorkerUser"):
            user = self.resources[name]
            self.assertEqual(user["DeletionPolicy"], "Retain")
            self.assertEqual(user["UpdateReplacePolicy"], "Retain")
            self.assertEqual(user["Properties"]["Path"], "/thechat/attachments/")
            self.assertNotIn("Policies", user["Properties"])

        rule = self.template["Rules"]["DedicatedAttachmentUsersMustDiffer"]
        self.assertEqual(
            rule["Assertions"][0]["Assert"],
            {
                "Not": [
                    {
                        "Equals": [
                            {"Ref": "ApiUserName"},
                            {"Ref": "WorkerUserName"},
                        ]
                    }
                ]
            },
        )

    def test_api_policy_matches_runtime_boundary_exactly(self) -> None:
        policy = self.resources["AttachmentApiPolicy"]
        self.assertEqual(policy["Properties"]["Users"], [{"Ref": "AttachmentApiUser"}])
        by_sid = statements(policy)
        self.assertEqual(
            set(by_sid),
            {
                "ReserveOneShotQuarantineUploads",
                "VerifyLatestQuarantineUpload",
                "AuthorizePinnedCleanDownloads",
            },
        )

        reserve = by_sid["ReserveOneShotQuarantineUploads"]
        self.assertEqual(actions(reserve), {"s3:PutObject"})
        self.assertEqual(
            sub_value(reserve["Resource"]),
            "${AttachmentsBucket.Arn}/quarantine/*",
        )
        self.assertEqual(
            reserve["Condition"],
            {
                "StringEquals": {"s3:if-none-match": "*"},
                "Null": {"s3:x-amz-copy-source": "true"},
            },
        )

        verify = by_sid["VerifyLatestQuarantineUpload"]
        self.assertEqual(actions(verify), {"s3:GetObject"})
        self.assertEqual(
            sub_value(verify["Resource"]),
            "${AttachmentsBucket.Arn}/quarantine/*",
        )

        download = by_sid["AuthorizePinnedCleanDownloads"]
        self.assertEqual(actions(download), {"s3:GetObjectVersion"})
        self.assertEqual(
            sub_value(download["Resource"]),
            "${AttachmentsBucket.Arn}/clean/*",
        )

        all_actions = set().union(*(actions(item) for item in by_sid.values()))
        self.assertFalse(any("List" in action for action in all_actions))
        self.assertFalse(any("Delete" in action for action in all_actions))

    def test_worker_policy_matches_runtime_boundary_exactly(self) -> None:
        policy = self.resources["AttachmentWorkerPolicy"]
        self.assertEqual(
            policy["Properties"]["Users"],
            [{"Ref": "AttachmentWorkerUser"}],
        )
        by_sid = statements(policy)
        self.assertEqual(
            set(by_sid),
            {
                "ValidatePinnedAttachmentVersions",
                "PromoteQuarantineObjectsToClean",
                "DeleteUnversionedQuarantineObjects",
                "DeletePinnedAttachmentVersions",
            },
        )

        reads = by_sid["ValidatePinnedAttachmentVersions"]
        self.assertEqual(actions(reads), {"s3:GetObjectVersion"})
        self.assertEqual(
            {sub_value(resource) for resource in reads["Resource"]},
            {
                "${AttachmentsBucket.Arn}/quarantine/*",
                "${AttachmentsBucket.Arn}/clean/*",
            },
        )

        promote = by_sid["PromoteQuarantineObjectsToClean"]
        self.assertEqual(actions(promote), {"s3:PutObject"})
        self.assertEqual(
            sub_value(promote["Resource"]),
            "${AttachmentsBucket.Arn}/clean/*",
        )
        self.assertEqual(
            promote["Condition"],
            {
                "StringLike": {
                    "s3:x-amz-copy-source": {
                        "Sub": "${AttachmentsBucket}/quarantine/*"
                    }
                }
            },
        )

        unversioned_delete = by_sid["DeleteUnversionedQuarantineObjects"]
        self.assertEqual(actions(unversioned_delete), {"s3:DeleteObject"})
        self.assertEqual(
            sub_value(unversioned_delete["Resource"]),
            "${AttachmentsBucket.Arn}/quarantine/*",
        )

        versioned_delete = by_sid["DeletePinnedAttachmentVersions"]
        self.assertEqual(actions(versioned_delete), {"s3:DeleteObjectVersion"})
        self.assertEqual(
            {sub_value(resource) for resource in versioned_delete["Resource"]},
            {
                "${AttachmentsBucket.Arn}/quarantine/*",
                "${AttachmentsBucket.Arn}/clean/*",
            },
        )
        all_actions = set().union(*(actions(item) for item in by_sid.values()))
        self.assertFalse(any("List" in action for action in all_actions))
        self.assertNotIn("s3:GetObject", all_actions)

    def test_object_store_command_surface_stays_within_reviewed_policies(self) -> None:
        source = OBJECT_STORE_SOURCE.read_text(encoding="utf-8")
        commands = set(re.findall(r"\bnew\s+([A-Za-z0-9]+Command)\s*\(", source))

        self.assertEqual(
            commands,
            {
                "CopyObjectCommand",
                "DeleteObjectCommand",
                "GetObjectCommand",
                "HeadObjectCommand",
                "PutObjectCommand",
            },
            "A new S3 command requires a reviewed API/worker policy update",
        )
        self.assertIn('IfNoneMatch: "*"', source)
        self.assertIn("VersionId: input.versionId", source)
        self.assertIn("CopySource: source", source)

    def test_production_cors_is_minimal_and_packaged_desktop_only(self) -> None:
        bucket = self.resources["AttachmentsBucket"]["Properties"]
        rules = bucket["CorsConfiguration"]["CorsRules"]

        self.assertEqual(len(rules), 1)
        self.assertEqual(
            rules[0],
            {
                "Id": "TheChatPackagedDesktopClients",
                "AllowedOrigins": ["http://tauri.localhost", "tauri://localhost"],
                "AllowedMethods": ["GET", "PUT"],
                "AllowedHeaders": [
                    "Content-Type",
                    "If-None-Match",
                    "x-amz-checksum-sha256",
                ],
                "MaxAge": 300,
            },
        )

        tauri_config = json.loads(TAURI_CONFIG.read_text(encoding="utf-8"))
        self.assertTrue(
            all(
                not window.get("useHttpsScheme", False)
                for window in tauri_config["app"]["windows"]
            ),
            "A Tauri HTTPS-scheme change requires a reviewed CORS update",
        )

    def test_storage_is_private_versioned_retained_and_bounded(self) -> None:
        bucket_resource = self.resources["AttachmentsBucket"]
        bucket = bucket_resource["Properties"]

        self.assertEqual(bucket_resource["DeletionPolicy"], "Retain")
        self.assertEqual(bucket_resource["UpdateReplacePolicy"], "Retain")
        self.assertEqual(
            bucket["BucketEncryption"]["ServerSideEncryptionConfiguration"][0][
                "ServerSideEncryptionByDefault"
            ]["SSEAlgorithm"],
            "AES256",
        )
        self.assertEqual(bucket["VersioningConfiguration"]["Status"], "Enabled")
        self.assertEqual(
            bucket["PublicAccessBlockConfiguration"],
            {
                "BlockPublicAcls": True,
                "IgnorePublicAcls": True,
                "BlockPublicPolicy": True,
                "RestrictPublicBuckets": True,
            },
        )

        retention = self.template["Parameters"]["CleanObjectRetentionDays"]
        self.assertEqual(retention["Default"], 30)
        self.assertEqual(retention["MinValue"], 30)
        lifecycle = {
            rule["Id"]: rule for rule in bucket["LifecycleConfiguration"]["Rules"]
        }
        quarantine = lifecycle["ExpireQuarantineObjectVersions"]
        self.assertEqual(quarantine["ExpirationInDays"], 1)
        self.assertEqual(quarantine["NoncurrentVersionExpiration"]["NoncurrentDays"], 1)
        self.assertTrue(
            lifecycle["RemoveExpiredQuarantineDeleteMarkers"][
                "ExpiredObjectDeleteMarker"
            ]
        )
        clean = lifecycle["ExpireCleanObjectVersions"]
        self.assertEqual(clean["ExpirationInDays"], {"Ref": "CleanObjectRetentionDays"})
        self.assertEqual(
            clean["NoncurrentVersionExpiration"]["NoncurrentDays"],
            {"Ref": "CleanObjectRetentionDays"},
        )
        self.assertTrue(
            lifecycle["RemoveExpiredCleanDeleteMarkers"]["ExpiredObjectDeleteMarker"]
        )
        self.assertEqual(
            lifecycle["AbortIncompleteMultipartUploads"][
                "AbortIncompleteMultipartUpload"
            ]["DaysAfterInitiation"],
            1,
        )

    def test_bucket_policy_is_retained_and_enforces_transport_expiry_encryption(self) -> None:
        policy = self.resources["AttachmentsBucketPolicy"]
        self.assertEqual(policy["DeletionPolicy"], "Retain")
        self.assertEqual(policy["UpdateReplacePolicy"], "Retain")
        by_sid = statements(policy)
        self.assertEqual(
            set(by_sid),
            {
                "DenyInsecureTransport",
                "DenyStalePresignedObjectRequests",
                "DenySseCustomerProvidedKeys",
                "DenyExplicitNonSseS3Encryption",
            },
        )

        insecure = by_sid["DenyInsecureTransport"]
        self.assertEqual(insecure["Effect"], "Deny")
        self.assertEqual(
            insecure["Condition"]["Bool"],
            {
                "aws:SecureTransport": "false",
                "aws:PrincipalIsAWSService": "false",
            },
        )

        stale = by_sid["DenyStalePresignedObjectRequests"]
        self.assertEqual(actions(stale), {"s3:GetObject", "s3:PutObject"})
        self.assertEqual(
            stale["Condition"],
            {
                "StringEquals": {"s3:authType": "REST-QUERY-STRING"},
                "NumericGreaterThan": {"s3:signatureAge": "900000"},
            },
        )

        sse_c = by_sid["DenySseCustomerProvidedKeys"]
        self.assertEqual(actions(sse_c), {"s3:PutObject"})
        self.assertEqual(
            sse_c["Condition"],
            {
                "Null": {
                    "s3:x-amz-server-side-encryption-customer-algorithm": "false"
                }
            },
        )
        alternate = by_sid["DenyExplicitNonSseS3Encryption"]
        self.assertEqual(
            alternate["Condition"],
            {
                "Null": {"s3:x-amz-server-side-encryption": "false"},
                "StringNotEquals": {"s3:x-amz-server-side-encryption": "AES256"},
            },
        )

    def test_bucket_parameter_excludes_dotted_virtual_host_names(self) -> None:
        parameter = self.template["Parameters"]["BucketName"]
        pattern = re.compile(parameter["AllowedPattern"])
        self.assertIsNotNone(pattern.fullmatch("thechat-attachments-production-123"))
        self.assertIsNone(pattern.fullmatch("thechat.attachments.production"))
        self.assertIsNone(pattern.fullmatch("-thechat-attachments"))

    def test_outputs_contain_identity_handles_but_no_credentials(self) -> None:
        output_names = set(self.template["Outputs"])
        self.assertEqual(
            output_names,
            {
                "BucketName",
                "BucketArn",
                "Region",
                "AttachmentApiUserName",
                "AttachmentApiUserArn",
                "AttachmentWorkerUserName",
                "AttachmentWorkerUserArn",
            },
        )
        serialized_outputs = str(self.template["Outputs"])
        self.assertNotIn("SecretAccessKey", serialized_outputs)
        self.assertNotIn("AccessKeyId", serialized_outputs)

    def test_development_template_remains_separate(self) -> None:
        development = load_template(DEVELOPMENT_TEMPLATE)
        resource_types = [
            resource["Type"] for resource in development["Resources"].values()
        ]
        self.assertNotIn("AWS::IAM::User", resource_types)
        self.assertNotIn("AWS::IAM::AccessKey", resource_types)
        self.assertIn("AWS::IAM::Role", resource_types)

        origins = development["Resources"]["AttachmentsBucket"]["Properties"][
            "CorsConfiguration"
        ]["CorsRules"][0]["AllowedOrigins"]
        self.assertEqual(
            origins,
            [
                "http://localhost:1420",
                "http://127.0.0.1:1420",
                "http://tauri.localhost",
                "tauri://localhost",
            ],
        )

    def test_supply_chain_and_operational_guards_are_regression_tested(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        action_refs = re.findall(r"uses:\s+[^@\s]+@([^\s#]+)", workflow)
        self.assertGreaterEqual(len(action_refs), 3)
        self.assertTrue(
            all(re.fullmatch(r"[0-9a-f]{40}", ref) for ref in action_refs),
            "Every third-party workflow action must be pinned to a full commit SHA",
        )

        runbook = RUNBOOK.read_text(encoding="utf-8")
        for required in (
            "create-change-set",
            "CAPABILITY_NAMED_IAM",
            "create_and_store_initial_key",
            "rollback_uncommitted_key",
            "current-release-values.yaml",
            "identityId=$INFISICAL_ID",
            "Rotation rollback",
            "previous.env",
            "--dry-run=server",
        ):
            self.assertIn(required, runbook)

        canary = CANARY.read_text(encoding="utf-8")
        for required in (
            "--if-none-match '*'",
            "API PutObject quarantine without If-None-Match",
            "worker direct PutObject clean without a quarantine copy source",
            "worker CopyObject clean from a clean source",
        ):
            self.assertIn(required, canary)


if __name__ == "__main__":
    unittest.main()
