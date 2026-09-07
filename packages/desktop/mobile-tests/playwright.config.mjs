import { defineConfig } from "./support.mjs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const artifacts = process.env.MOBILE_ARTIFACTS_DIR || path.join(os.homedir(), ".cache", "thechat", "mobile-tests");
export default defineConfig({
  testDir: here,
  testMatch: "mobile.pw.mjs",
  workers: 1,
  retries: 0,
  timeout: 30000,
  outputDir: path.join(artifacts, "test-results"),
  reporter: [["list"], ["json", { outputFile: path.join(artifacts, "results.json") }], ["html", { outputFolder: path.join(artifacts, "report"), open: "never" }]],
  use: { baseURL: "http://127.0.0.1:1433", viewport: { width: 320, height: 640 }, hasTouch: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }, { name: "webkit", use: { browserName: "webkit" } }],
  webServer: { command: "pnpm --filter @thechat/desktop exec vite --config mobile-tests/vite.config.mjs", cwd: path.resolve(here, "../../.."), url: "http://127.0.0.1:1433", reuseExistingServer: false },
});
