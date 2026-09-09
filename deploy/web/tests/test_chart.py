#!/usr/bin/env python3
"""Render actual Helm manifests; no cluster access. Requires helm + PyYAML.

THECHAT_LIVE_VALUES optionally points at an operator's private helm-get-values
snapshot. It is never printed or committed. The default is a non-secret fixture
of revision-18 facts, NOT a complete production values export.
"""
from pathlib import Path
import os
import subprocess
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[3]
CHART = ROOT / "deploy/web"
DIGEST = "sha256:" + "a" * 64  # Synthetic render fixture, not a published image.


def render(chart, *args, ok=True):
    result = subprocess.run(["helm", "template", "thechat-web" if chart == CHART else "thechat-api",
                             str(chart), "--namespace", "thechat", *map(str, args)], text=True, capture_output=True)
    if ok:
        if result.returncode:
            raise AssertionError(result.stderr)
        return [item for item in yaml.safe_load_all(result.stdout) if item]
    return result


def kind(documents, name):
    return next(doc for doc in documents if doc["kind"] == name)


class WebChartTests(unittest.TestCase):
    def test_independent_default_release_has_no_state_or_credentials(self):
        self.assertTrue((CHART / "Chart.yaml").exists(), "Missing standalone web Helm chart")
        docs = render(CHART)
        self.assertEqual(sorted(doc["kind"] for doc in docs), ["Deployment", "Service"])
        pod = kind(docs, "Deployment")["spec"]["template"]["spec"]
        self.assertIs(pod["automountServiceAccountToken"], False)
        self.assertEqual(pod["securityContext"], {"runAsNonRoot": True, "runAsUser": 101,
                         "runAsGroup": 101, "seccompProfile": {"type": "RuntimeDefault"}})
        container = pod["containers"][0]
        self.assertNotIn("env", container)
        self.assertNotIn("envFrom", container)
        self.assertEqual(container["securityContext"], {"allowPrivilegeEscalation": False,
                         "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}})
        self.assertEqual(container["ports"][0]["containerPort"], 8080)
        for probe in ["livenessProbe", "readinessProbe"]:
            self.assertEqual(container[probe]["httpGet"], {"path": "/healthz", "port": "http"})
        self.assertEqual(pod["volumes"], [{"name": "tmp", "emptyDir": {"medium": "Memory", "sizeLimit": "32Mi"}}])

    def test_production_tls_requires_an_immutable_digest(self):
        values = CHART / "values-production.yaml"
        self.assertTrue(values.exists(), "Missing production web overlay")
        error = render(CHART, "-f", values, ok=False)
        self.assertNotEqual(error.returncode, 0)
        self.assertIn("production requires image.digest", error.stderr)
        docs = render(CHART, "-f", values, "--set", "image.digest=" + DIGEST)
        image = kind(docs, "Deployment")["spec"]["template"]["spec"]["containers"][0]["image"]
        self.assertEqual(image, "ghcr.io/crosslink-ch/thechat-web@" + DIGEST)
        ingress = kind(docs, "Ingress")
        self.assertEqual(ingress["metadata"]["annotations"]["cert-manager.io/cluster-issuer"], "letsencrypt-prod")
        self.assertEqual(ingress["spec"]["ingressClassName"], "traefik")
        self.assertEqual(ingress["spec"]["tls"], [{"hosts": ["thechat.pranexa.com"], "secretName": "thechat-web-pranexa-tls"}])
        self.assertEqual([x["host"] for x in ingress["spec"]["rules"]], ["thechat.pranexa.com"])
        invalid = render(CHART, "-f", values, "--set", "image.digest=latest", ok=False)
        self.assertNotEqual(invalid.returncode, 0)

    def test_web_production_never_schedules_on_storage_only_node(self):
        docs = render(CHART, "-f", CHART / "values-production.yaml", "--set", "image.digest=" + DIGEST)
        pod = kind(docs, "Deployment")["spec"]["template"]["spec"]
        required = pod.get("affinity", {}).get("nodeAffinity", {}).get("requiredDuringSchedulingIgnoredDuringExecution", {})
        terms = required.get("nodeSelectorTerms", [])
        self.assertTrue(terms, "Missing required storage-node exclusion")
        exclusion = {"key": "kubernetes.io/hostname", "operator": "NotIn", "values": ["cl-agent-storage-vbe"]}
        self.assertTrue(all(exclusion in term["matchExpressions"] for term in terms))

    def test_api_overlay_preserves_existing_release_settings_and_desktop_route(self):
        overlay = ROOT / "deploy/api/values-web-production.yaml"
        self.assertTrue(overlay.exists(), "Missing additive API browser overlay")
        # No image/DB/worker/storage/SMTP/verification defaults may be reset here.
        raw = yaml.safe_load(overlay.read_text())
        self.assertEqual(set(raw), {"env", "ingress"})
        self.assertEqual(set(raw["env"]), {"THECHAT_WEB_ORIGINS", "BETTER_AUTH_URL", "THECHAT_BACKEND_URL", "ATTACHMENT_S3_PUBLIC_ENDPOINT"})
        self.assertEqual(raw["env"]["ATTACHMENT_S3_PUBLIC_ENDPOINT"], "https://s3.dualstack.eu-central-1.amazonaws.com")
        live = os.environ.get("THECHAT_LIVE_VALUES", str(CHART / "tests/values-api-revision18.fixture.yaml"))
        before = render(ROOT / "deploy/api", "-f", live)
        after = render(ROOT / "deploy/api", "-f", live, "-f", overlay)
        before_deployment = kind(before, "Deployment")
        after_deployment = kind(after, "Deployment")
        # Only public URLs/origin differ in every pod environment; all Secret refs,
        # mail verification, credentials, resources and all state remain identical.
        for old, new in zip(before, after):
            if old["kind"] == "Ingress":
                continue
            new = yaml.safe_load(yaml.safe_dump(new))
            old = yaml.safe_load(yaml.safe_dump(old))
            if new["kind"] in ["Deployment", "Job"]:
                for doc in [old, new]:
                    for c in doc["spec"]["template"]["spec"]["containers"]:
                        c["env"] = [e for e in c.get("env", []) if e["name"] not in raw["env"]]
            self.assertEqual(new, old, old["metadata"]["name"])
        self.assertEqual(len(before), len(after))
        ingress = kind(after, "Ingress")["spec"]
        self.assertEqual([x["host"] for x in ingress["rules"]], ["thechat.testkopie.dev", "thechat-api.pranexa.com"])
        self.assertEqual(ingress["tls"], [{"hosts": ["thechat-api.pranexa.com"], "secretName": "thechat-api-pranexa-tls"}])
        env = {e["name"]: e for e in after_deployment["spec"]["template"]["spec"]["containers"][0]["env"]}
        self.assertEqual(env["THECHAT_WEB_ORIGINS"]["value"], "https://thechat.pranexa.com")
        for key in ["BETTER_AUTH_URL", "THECHAT_BACKEND_URL"]:
            self.assertEqual(env[key]["value"], "https://thechat-api.pranexa.com")
        self.assertEqual(env["REQUIRE_EMAIL_VERIFICATION"]["value"], "true")
        self.assertEqual(env["DATABASE_URL"]["valueFrom"]["secretKeyRef"]["name"], "thechat-db-v3")


if __name__ == "__main__":
    unittest.main()
