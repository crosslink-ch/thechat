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
if (process.env.THECHAT_E2E_DISABLE_DOTENV !== "1" && fs.existsSync(envFile)) {
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

async function stopTauriDriver() {
  if (!tauriDriver) return;
  const proc = tauriDriver;
  tauriDriver = null;
  // Kill the entire process group (tauri-driver + Tauri binary).
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {}
  await new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    proc.once("close", resolve);
    setTimeout(resolve, 5000);
  });
  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
  }
}

function removeTmpDataDir() {
  delete process.env.THECHAT_DATA_DIR;
  if (!tmpDataDir) return;
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  tmpDataDir = null;
}

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
    timeout: Number(process.env.WDIO_MOCHA_TIMEOUT ?? "60000"),
  },

  hostname: "localhost",
  port: TAURI_DRIVER_PORT,

  async onPrepare() {
    if (process.env.SKIP_BUILD !== "1") {
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
      detached: true,
    });

    let driverSpawnError = null;
    tauriDriver.once("error", (error) => {
      driverSpawnError = error;
    });
    tauriDriver.stdout.resume();
    tauriDriver.stderr.on("data", (data) => {
      const msg = data.toString();
      if (msg.trim()) console.error("[tauri-driver]", msg.trim());
    });

    // Wait for tauri-driver to be ready. A failed startup must cancel both the
    // readiness poll and the detached driver process group because afterSession
    // is not guaranteed to run when beforeSession rejects.
    const driverProcess = tauriDriver;
    try {
      await new Promise((resolve, reject) => {
        let finished = false;
        let timeout;
        const fail = (error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          reject(error);
        };
        timeout = setTimeout(() => {
          fail(new Error("tauri-driver failed to start within 10s"));
        }, 10000);

        const check = async () => {
          if (finished) return;
          if (driverSpawnError) {
            fail(
              new Error(
                `tauri-driver failed to spawn: ${driverSpawnError.message}`,
              ),
            );
            return;
          }
          if (
            driverProcess.exitCode !== null ||
            driverProcess.signalCode !== null
          ) {
            fail(
              new Error(
                `tauri-driver exited before readiness (${driverProcess.exitCode ?? driverProcess.signalCode})`,
              ),
            );
            return;
          }
          try {
            const res = await fetch(
              `http://localhost:${TAURI_DRIVER_PORT}/status`,
            );
            if (res.ok) {
              finished = true;
              clearTimeout(timeout);
              resolve();
              return;
            }
          } catch {
            // not ready yet
          }
          if (!finished) setTimeout(check, 200);
        };
        check();
      });
    } catch (error) {
      await stopTauriDriver();
      removeTmpDataDir();
      throw error;
    }
  },

  async afterSession() {
    await stopTauriDriver();
    removeTmpDataDir();
  },
};

// Cleanup on unexpected termination
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (tauriDriver) {
      try {
        process.kill(-tauriDriver.pid, "SIGTERM");
      } catch {}
      tauriDriver = null;
    }
    removeTmpDataDir();
    process.exit(1);
  });
}
