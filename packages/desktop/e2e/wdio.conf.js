import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");

// Load .env from monorepo root (no dotenv dependency needed).
// Existing env vars take precedence — this only fills in missing ones.
const envFile = path.resolve(packageDir, "../../.env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const TAURI_DRIVER_PORT = 4444;

let tauriDriver;
let tmpDataDir;

export const config = {
  specs: [path.resolve(__dirname, "specs/**/*.e2e.js")],
  maxInstances: 1,
  capabilities: [{}],
  logLevel: "warn",
  waitforTimeout: 10000,
  connectionRetryTimeout: 30000,
  connectionRetryCount: 3,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },

  hostname: "localhost",
  port: TAURI_DRIVER_PORT,

  async onPrepare() {
    if (!process.env.SKIP_BUILD) {
      console.log("Building Tauri binary (set SKIP_BUILD=1 to skip)...");
      execSync(
        "pnpm --filter @thechat/desktop tauri build --debug --no-bundle",
        {
          stdio: "inherit",
          cwd: path.resolve(packageDir, "../.."),
        },
      );
    }
  },

  async beforeSession(_config, capabilities) {
    // Create isolated data directory so each run gets a fresh SQLite DB.
    // The Rust binary checks THECHAT_DATA_DIR before the default path.
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "thechat-e2e-"));
    process.env.THECHAT_DATA_DIR = tmpDataDir;

    capabilities["tauri:options"] = {
      application: path.resolve(packageDir, "src-tauri/target/debug/thechat"),
    };

    tauriDriver = spawn("tauri-driver", ["--port", String(TAURI_DRIVER_PORT)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    tauriDriver.stderr.on("data", (data) => {
      const msg = data.toString();
      if (msg.trim()) console.error("[tauri-driver]", msg.trim());
    });

    // Wait for tauri-driver to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("tauri-driver failed to start within 10s"));
      }, 10000);

      const check = async () => {
        try {
          const res = await fetch(
            `http://localhost:${TAURI_DRIVER_PORT}/status`,
          );
          if (res.ok) {
            clearTimeout(timeout);
            resolve();
            return;
          }
        } catch {
          // not ready yet
        }
        setTimeout(check, 200);
      };
      check();
    });
  },

  async afterSession() {
    if (tauriDriver) {
      tauriDriver.kill("SIGTERM");
      tauriDriver = null;
    }
    delete process.env.THECHAT_DATA_DIR;
    if (tmpDataDir) {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
      tmpDataDir = null;
    }
  },
};

// Cleanup on unexpected termination
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (tauriDriver) {
      tauriDriver.kill("SIGTERM");
      tauriDriver = null;
    }
    if (tmpDataDir) {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
      tmpDataDir = null;
    }
    process.exit(1);
  });
}
