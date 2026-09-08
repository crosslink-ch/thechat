#!/usr/bin/env python3
"""Publication trust-boundary sentinels; actual image behavior is test_image.py."""
from pathlib import Path
import re
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[3]


class WorkflowTests(unittest.TestCase):
    def test_only_main_can_publish_the_exact_smoked_full_sha_image(self):
        path = ROOT / ".github/workflows/web-image.yml"
        self.assertTrue(path.exists(), "Missing immutable frontend image workflow")
        source = path.read_text()
        workflow = yaml.safe_load(source)
        triggers = workflow.get("on", workflow.get(True))
        self.assertEqual(triggers["push"]["branches"], ["main"])
        self.assertNotIn("pull_request_target", triggers)
        self.assertNotIn("pull_request", triggers)
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        job = workflow["jobs"]["build-and-push"]
        self.assertIn("github.ref == 'refs/heads/main'", job["if"])
        self.assertEqual(job["permissions"], {"contents": "read", "packages": "write"})
        self.assertFalse(workflow["concurrency"]["cancel-in-progress"])
        self.assertEqual(job["runs-on"], "ubuntu-latest")
        for step in job["steps"]:
            if "uses" in step:
                self.assertRegex(step["uses"], r"@[a-f0-9]{40}$")
        steps = "\n".join(step.get("run", "") for step in job["steps"])
        self.assertIn('sha-${GITHUB_SHA}', steps)
        self.assertNotIn(":latest", steps)
        self.assertLess(steps.index("test_image.py"), steps.index("docker login"))
        self.assertLess(steps.index("test_image.py"), steps.index("docker push"))
        self.assertIn("refs/heads/main", steps)
        self.assertIn(".object.sha", steps)
        self.assertIn("--password-stdin", steps)
        self.assertIn("org.opencontainers.image.revision", steps)
        self.assertNotIn("helm upgrade", steps)
        self.assertNotIn("kubectl", steps)
        self.assertIn("RepoDigests", steps)
        definitions = (ROOT / ".github/workflows/helm-chart.yml").read_text()
        for required in ["deploy/web/**", "web-image.yml", "deploy/web/tests/test_chart.py", "deploy/web/tests/test_workflow.py"]:
            self.assertIn(required, definitions)


if __name__ == "__main__":
    unittest.main()
