#!/usr/bin/env python3
"""Build and smoke the actual static image. No backend or credentials required.

Run from any cwd: python3 deploy/web/tests/test_image.py
THECHAT_WEB_TEST_IMAGE can select an already built image (CI tests before push).
"""
import json
import os
from pathlib import Path
import re
import subprocess
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import urlopen
import uuid

ROOT = Path(__file__).resolve().parents[3]


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


class StaticImageTests(unittest.TestCase):
    def test_production_image_serves_spa_safely_without_a_backend(self):
        dockerfile = ROOT / "deploy/web/Dockerfile"
        self.assertTrue(dockerfile.is_file(), "Missing production static frontend Dockerfile")
        image = os.environ.get("THECHAT_WEB_TEST_IMAGE")
        if not image:
            image = "thechat-web-smoke:" + uuid.uuid4().hex[:12]
            subprocess.run(["docker", "build", "--file", str(dockerfile), "--tag", image, str(ROOT)], check=True)
        config = json.loads(docker("image", "inspect", image))[0]["Config"]
        self.assertEqual(config["User"], "101:101")
        name = "thechat-web-smoke-" + uuid.uuid4().hex[:12]
        try:
            docker("run", "--detach", "--name", name, "--read-only", "--cap-drop=ALL",
                   "--security-opt=no-new-privileges", "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
                   "--publish", "127.0.0.1::8080", image)
            port = docker("port", name, "8080/tcp").rsplit(":", 1)[1]
            origin = f"http://127.0.0.1:{port}"

            def get(path):
                try:
                    response = urlopen(origin + path, timeout=3)
                except HTTPError as error:
                    response = error
                with response:
                    return response.status, response.headers, response.read()

            for attempt in range(40):
                try:
                    if get("/healthz")[0] == 200:
                        break
                except (URLError, TimeoutError):
                    pass
                time.sleep(0.25)
            else:
                self.fail("Static image failed readiness: " + docker("logs", name))
            # Real IPv6 loopback request inside the same container, not only nginx syntax.
            self.assertEqual(docker("exec", name, "wget", "-qO-", "http://[::1]:8080/healthz"), "ok")
            status, headers, index = get("/")
            self.assertEqual(status, 200)
            self.assertIn("text/html", headers["Content-Type"])
            self.assertIn("no-store", headers["Cache-Control"])
            self.assertEqual(get("/workspace/deep/link")[2], index)
            for path in ["/", "/index.html", "/workspace/deep/link", "/thechat.png", "/assets/missing.js", "/.env"]:
                _, response_headers, _ = get(path)
                self.assertEqual(response_headers["X-Content-Type-Options"], "nosniff", path)
                self.assertEqual(response_headers["X-Frame-Options"], "DENY", path)
                self.assertEqual(response_headers["Referrer-Policy"], "strict-origin-when-cross-origin", path)
                csp = response_headers["Content-Security-Policy"]
                self.assertIn("frame-ancestors 'none'", csp)
                self.assertIn("https://thechat-api.pranexa.com", csp)
                self.assertIn("wss://thechat-api.pranexa.com", csp)
                self.assertIn("https://*.s3.dualstack.eu-central-1.amazonaws.com", csp)
                self.assertIn("script-src 'self';", csp)
            for path in ["/assets/missing.js", "/.env", "/api", "/api/auth/me"]:
                self.assertEqual(get(path)[0], 404, path)
            script = re.search(rb'<script[^>]+src="([^"]+)"', index).group(1).decode()
            asset_status, asset_headers, bundle = get(script)
            self.assertEqual(asset_status, 200)
            self.assertIn("javascript", asset_headers["Content-Type"])
            self.assertIn("max-age=31536000, immutable", asset_headers["Cache-Control"])
            self.assertIn(b"https://thechat-api.pranexa.com", bundle)
            self.assertIn(b"wss://thechat-api.pranexa.com/ws", bundle)
            self.assertNotIn(b"http://localhost:3000", bundle)
            self.assertNotIn("immutable", get("/thechat.png")[1].get("Cache-Control", ""))
            self.assertNotIn("immutable", get("/assets/missing.js")[1].get("Cache-Control", ""))
            print(json.dumps({"image": image, "id": json.loads(docker("image", "inspect", image))[0]["Id"],
                              "ipv4": "passed", "ipv6": "passed", "spa_headers_assets": "passed"}))
        finally:
            docker("rm", "--force", name)


if __name__ == "__main__":
    unittest.main()
