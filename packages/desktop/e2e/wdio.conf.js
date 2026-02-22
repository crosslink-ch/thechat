import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");

const TAURI_DRIVER_PORT = 4444;

let tauriDriver;

export const config = {
  specs: [path.resolve(__dirname, "specs/**/*.e2e.js")],
  maxInstances: 1,
  capabilities: [
    {
      "tauri:options": {
        application: path.resolve(
          packageDir,
          "src-tauri/target/debug/thechat",
        ),
      },
    },
  ],
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

  async beforeSession() {
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
  },
};

// Cleanup on unexpected termination
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (tauriDriver) {
      tauriDriver.kill("SIGTERM");
      tauriDriver = null;
    }
    process.exit(1);
  });
}
