#!/usr/bin/env python3
"""Render-level tests for attachment credential isolation and Infisical sync."""

from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path

CHART = Path(__file__).resolve().parents[1]
PRODUCTION_VALUES = CHART / "values-production.example.yaml"


def credential_values(*extra: str) -> tuple[str, ...]:
    return (
        "attachments.credentials.enabled=true",
        "env.ATTACHMENT_S3_BUCKET=thechat-test-attachments",
        *extra,
    )


def infisical_values(*extra: str) -> tuple[str, ...]:
    return credential_values(
        "attachments.infisical.enabled=true",
        "attachments.infisical.identityId=11111111-1111-4111-8111-111111111111",
        "attachments.infisical.projectSlug=thechat-production",
        *extra,
    )


def render(
    *values: str,
    template: str | None = None,
    json_values: tuple[str, ...] = (),
    values_file: Path | None = None,
) -> str:
    command = [
        "helm",
        "template",
        "thechat-api",
        str(CHART),
        "--namespace",
        "thechat",
        "--set",
        "image.tag=sha-0123456789ab",
        "--set",
        "migrateImage.tag=sha-0123456789ab",
    ]
    if template:
        command.extend(("--show-only", template))
    if values_file:
        command.extend(("--values", str(values_file)))
    for value in values:
        command.extend(("--set", value))
    for value in json_values:
        command.extend(("--set-json", value))

    return subprocess.run(
        command,
        check=True,
        text=True,
        capture_output=True,
    ).stdout


def deployment_document(rendered: str, name: str) -> str:
    marker = f"kind: Deployment\nmetadata:\n  name: {name}\n"
    for document in rendered.split("---\n"):
        if marker in document:
            return f"---\n{document}"
    raise AssertionError(f"Deployment {name!r} not found in rendered chart")


class AttachmentCredentialRenderTests(unittest.TestCase):
    def test_credentials_are_absent_by_default(self) -> None:
        rendered = render()

        self.assertNotIn("AWS_ACCESS_KEY_ID", rendered)
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", rendered)
        self.assertNotIn("AWS_SESSION_TOKEN", rendered)
        self.assertNotIn("kind: InfisicalSecret", rendered)

    def test_legacy_null_attachment_values_remain_renderable(self) -> None:
        rendered = render(json_values=("attachments=null",))

        self.assertNotIn("AWS_ACCESS_KEY_ID", rendered)
        self.assertNotIn("kind: InfisicalSecret", rendered)

    def test_api_and_worker_use_distinct_existing_secrets(self) -> None:
        rendered = render(
            *infisical_values(
                "attachments.credentials.api.secretName=api-aws-creds",
                "attachments.credentials.worker.secretName=worker-aws-creds",
                "attachments.credentials.api.accessKeyIdKey=API_ACCESS_KEY",
                "attachments.credentials.api.secretAccessKeyKey=API_SECRET_KEY",
                "attachments.credentials.worker.accessKeyIdKey=WORKER_ACCESS_KEY",
                "attachments.credentials.worker.secretAccessKeyKey=WORKER_SECRET_KEY",
            )
        )
        api = deployment_document(rendered, "thechat-api")
        worker = deployment_document(rendered, "thechat-api-worker")

        self.assertIn("serviceAccountName: thechat-api", api)
        self.assertIn("automountServiceAccountToken: false", api)
        self.assertIn("serviceAccountName: thechat-api-worker", worker)
        self.assertIn("automountServiceAccountToken: false", worker)
        self.assertIn("name: api-aws-creds", api)
        self.assertIn('key: "API_ACCESS_KEY"', api)
        self.assertIn('key: "API_SECRET_KEY"', api)
        self.assertNotIn("worker-aws-creds", api)
        self.assertIn("name: worker-aws-creds", worker)
        self.assertIn('key: "WORKER_ACCESS_KEY"', worker)
        self.assertIn('key: "WORKER_SECRET_KEY"', worker)
        self.assertNotIn("api-aws-creds", worker)
        self.assertEqual(
            rendered.count('"API_ACCESS_KEY": "{{ .AWS_ACCESS_KEY_ID.Value }}"'),
            1,
        )
        self.assertEqual(
            rendered.count('"API_SECRET_KEY": "{{ .AWS_SECRET_ACCESS_KEY.Value }}"'),
            1,
        )
        self.assertEqual(
            rendered.count('"WORKER_ACCESS_KEY": "{{ .AWS_ACCESS_KEY_ID.Value }}"'),
            1,
        )
        self.assertEqual(
            rendered.count('"WORKER_SECRET_KEY": "{{ .AWS_SECRET_ACCESS_KEY.Value }}"'),
            1,
        )
        self.assertNotIn("AWS_SESSION_TOKEN", rendered)

    def test_default_secret_names_still_isolate_workloads(self) -> None:
        rendered = render(*credential_values())
        api = deployment_document(rendered, "thechat-api")
        worker = deployment_document(rendered, "thechat-api-worker")

        self.assertIn("name: thechat-api-attachments-api-aws", api)
        self.assertNotIn("thechat-api-attachments-worker-aws", api)
        self.assertIn("name: thechat-api-attachments-worker-aws", worker)
        self.assertNotIn("thechat-api-attachments-api-aws", worker)

    def test_infisical_sync_uses_shared_identity_with_isolated_targets(self) -> None:
        rendered = render(*infisical_values())

        self.assertEqual(rendered.count("kind: InfisicalSecret"), 2)
        self.assertEqual(
            rendered.count(
                'identityId: "11111111-1111-4111-8111-111111111111"'
            ),
            2,
        )
        self.assertIn('hostAPI: "https://infisical.testkopie.dev/api"', rendered)
        self.assertIn('projectSlug: "thechat-production"', rendered)
        self.assertIn('secretsPath: "/attachments/api"', rendered)
        self.assertIn('secretsPath: "/attachments/worker"', rendered)
        self.assertIn("name: thechat-api-attachments-api-aws", rendered)
        self.assertIn("name: thechat-api-attachments-worker-aws", rendered)
        self.assertRegex(
            rendered,
            re.compile(
                r"serviceAccountRef:\n\s+name: thechat-api\n\s+namespace: thechat"
            ),
        )
        self.assertRegex(
            rendered,
            re.compile(
                r"serviceAccountRef:\n\s+name: thechat-api-worker\n\s+namespace: thechat"
            ),
        )
        self.assertEqual(rendered.count("includeAllSecrets: false"), 2)
        self.assertEqual(
            rendered.count('"AWS_ACCESS_KEY_ID": "{{ .AWS_ACCESS_KEY_ID.Value }}"'),
            2,
        )
        self.assertEqual(
            rendered.count(
                '"AWS_SECRET_ACCESS_KEY": "{{ .AWS_SECRET_ACCESS_KEY.Value }}"'
            ),
            2,
        )
        self.assertNotIn("AWS_SESSION_TOKEN", rendered)

        api = deployment_document(rendered, "thechat-api")
        worker = deployment_document(rendered, "thechat-api-worker")
        self.assertIn('secrets.infisical.com/auto-reload: "true"', api)
        self.assertIn('secrets.infisical.com/auto-reload: "true"', worker)

    def test_production_example_renders_only_after_coordinates_are_supplied(self) -> None:
        source = PRODUCTION_VALUES.read_text(encoding="utf-8")
        self.assertIn("identityId: \"\"", source)
        self.assertIn("projectSlug: \"\"", source)
        self.assertIn("ATTACHMENT_S3_BUCKET: \"\"", source)

        rendered = render(
            "attachments.infisical.projectSlug=thechat-production",
            "attachments.infisical.identityId=11111111-1111-4111-8111-111111111111",
            "env.ATTACHMENT_S3_BUCKET=thechat-attachments-production",
            values_file=PRODUCTION_VALUES,
        )
        api = deployment_document(rendered, "thechat-api")
        worker = deployment_document(rendered, "thechat-api-worker")

        self.assertIn('value: "thechat-attachments-production"', api)
        self.assertIn("name: thechat-attachments-api-aws", api)
        self.assertNotIn("thechat-attachments-worker-aws", api)
        self.assertIn("name: thechat-attachments-worker-aws", worker)
        self.assertNotIn("thechat-attachments-api-aws", worker)
        self.assertEqual(rendered.count("kind: InfisicalSecret"), 2)
        self.assertIn('projectSlug: "thechat-production"', rendered)

    def test_infisical_requires_credential_injection(self) -> None:
        with self.assertRaises(subprocess.CalledProcessError) as error:
            render(
                "attachments.infisical.enabled=true",
                "attachments.infisical.projectSlug=thechat-production",
            )

        self.assertIn(
            "attachments.infisical.enabled requires "
            "attachments.credentials.enabled=true",
            error.exception.stderr,
        )

    def test_identity_isolation_misconfiguration_fails_rendering(self) -> None:
        cases = (
            (
                (
                    "serviceAccount.name=shared-service-account",
                    "worker.serviceAccount.name=shared-service-account",
                ),
                "API and worker service accounts must be distinct",
            ),
            (
                credential_values(
                    "attachments.credentials.api.secretName=shared-aws-creds",
                    "attachments.credentials.worker.secretName=shared-aws-creds",
                ),
                "API and worker attachment credential Secrets must be distinct",
            ),
            (
                credential_values(
                    "attachments.credentials.api.accessKeyIdKey=AWS_SECRET_ACCESS_KEY",
                ),
                "attachments.credentials.api access-key and secret-key entries must be distinct",
            ),
            (
                infisical_values(
                    "attachments.infisical.apiSecretsPath=/attachments/shared",
                    "attachments.infisical.workerSecretsPath=/attachments/shared",
                ),
                "API and worker Infisical paths must be distinct",
            ),
        )

        for values, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(subprocess.CalledProcessError) as error:
                    render(*values)
                self.assertIn(message, error.exception.stderr)

    def test_infisical_requires_a_project_slug(self) -> None:
        with self.assertRaises(subprocess.CalledProcessError) as error:
            render(*infisical_values("attachments.infisical.projectSlug="))

        self.assertIn(
            "attachments.infisical.projectSlug is required",
            error.exception.stderr,
        )

    def test_infisical_requires_an_identity_id(self) -> None:
        with self.assertRaises(subprocess.CalledProcessError) as error:
            render(*infisical_values("attachments.infisical.identityId="))

        self.assertIn(
            "attachments.infisical.identityId is required",
            error.exception.stderr,
        )

    def test_attachment_credentials_require_bucket_and_immutable_images(self) -> None:
        cases = (
            (
                credential_values("env.ATTACHMENT_S3_BUCKET="),
                "env.ATTACHMENT_S3_BUCKET is required",
            ),
            (
                credential_values("image.tag=latest", "migrateImage.tag=latest"),
                "image.tag must be an immutable sha-<hex> tag",
            ),
            (
                credential_values("migrateImage.tag=sha-deadbeef1234"),
                "image.tag and migrateImage.tag must match",
            ),
        )
        for values, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(subprocess.CalledProcessError) as error:
                    render(*values)
                self.assertIn(message, error.exception.stderr)

    def test_all_aws_environment_overrides_fail_closed(self) -> None:
        with self.assertRaises(subprocess.CalledProcessError) as error:
            render("env.AWS_ENDPOINT_URL=https://credentials-exfiltration.invalid")

        self.assertIn("env.AWS_ENDPOINT_URL is reserved", error.exception.stderr)


if __name__ == "__main__":
    unittest.main()
