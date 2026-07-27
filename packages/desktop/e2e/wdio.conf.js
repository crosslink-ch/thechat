import { spawn, execFileSync } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
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

const RUN_ID =
  process.env.THECHAT_E2E_RUN_ID ??
  `wdio-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const TAURI_DRIVER_PORT = Number(
  process.env.THECHAT_E2E_TAURI_DRIVER_PORT ?? randomInt(20_000, 60_000),
);
process.env.THECHAT_E2E_RUN_ID = RUN_ID;
process.env.THECHAT_E2E_TAURI_DRIVER_PORT = String(TAURI_DRIVER_PORT);
const OWNER_FILE = ".thechat-e2e-owner.json";
const repoRoot = path.resolve(packageDir, "../..");
const binaryPath = path.resolve(packageDir, "src-tauri/target/debug/thechat");
const evidenceHelper = path.resolve(repoRoot, "scripts/e2e/e2e_run.py");
const python = process.env.PYTHON ?? "python3";

let tauriDriver;
let tmpDataDir;
let originalPath;
let buildEvidence;

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function sourceIdentity() {
  return JSON.parse(
    execFileSync(python, [evidenceHelper, "source", "--root", repoRoot], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  );
}

function assertSameIdentity(expected, actual, label) {
  const keys = [
    "commit",
    "tree",
    "dirty",
    "statusSha256",
    "sourceManifestSha256",
    "manifestFileCount",
  ];
  const mismatches = Object.fromEntries(
    keys
      .filter((key) => expected[key] !== actual[key])
      .map((key) => [key, { expected: expected[key], actual: actual[key] }]),
  );
  if (Object.keys(mismatches).length > 0) {
    throw new Error(`${label}: ${JSON.stringify(mismatches)}`);
  }
}

async function refusePortCollision(port, label) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      reject(
        new Error(
          `Refusing ${label} collision on 127.0.0.1:${port}: ${error.message}`,
        ),
      );
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(resolve);
    });
  });
}

function verifyBuildBinding(label) {
  if (!buildEvidence && process.env.THECHAT_E2E_BUILD_EVIDENCE) {
    buildEvidence = JSON.parse(
      fs.readFileSync(process.env.THECHAT_E2E_BUILD_EVIDENCE, "utf8"),
    );
  }
  if (!buildEvidence) return;
  assertSameIdentity(buildEvidence.git, sourceIdentity(), `${label} source drift`);
  const actualBinary = sha256File(buildEvidence.binary.path);
  if (actualBinary !== buildEvidence.binary.sha256) {
    throw new Error(
      `${label} binary drift: expected ${buildEvidence.binary.sha256}, found ${actualBinary}`,
    );
  }
}

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
  if (originalPath !== undefined) {
    process.env.PATH = originalPath;
    originalPath = undefined;
  }
  if (!tmpDataDir) return;
  const markerPath = path.join(tmpDataDir, OWNER_FILE);
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  if (
    marker.owner !== "thechat-e2e" ||
    marker.runId !== RUN_ID ||
    marker.kind !== "tauri-data"
  ) {
    throw new Error(`Refusing cleanup for unowned Tauri data: ${tmpDataDir}`);
  }
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  tmpDataDir = null;
}

function prepareNativeOpenerProbe() {
  const marker = process.env.ATTACHMENT_E2E_OPENER_MARKER?.trim();
  if (!marker || !tmpDataDir) return;
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.rmSync(marker, { force: true });
  const binDir = path.join(tmpDataDir, "native-opener-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const script = [
    "#!/bin/sh",
    "set -eu",
    'marker="${ATTACHMENT_E2E_OPENER_MARKER:?}"',
    'target=""',
    'for argument in "$@"; do target="$argument"; done',
    'test -n "$target"',
    'printf "%s" "$target" > "$marker"',
    "exit 0",
    "",
  ].join("\n");
  for (const command of [
    "xdg-open",
    "gio",
    "gnome-open",
    "kde-open",
    "kde-open5",
  ]) {
    const executable = path.join(binDir, command);
    fs.writeFileSync(executable, script, { mode: 0o700 });
  }
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
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
    await refusePortCollision(TAURI_DRIVER_PORT, "tauri-driver port");
    const beforeBuild = sourceIdentity();
    const configuredExpected = process.env.THECHAT_E2E_EXPECTED_SOURCE_IDENTITY;
    if (configuredExpected) {
      assertSameIdentity(
        JSON.parse(configuredExpected),
        beforeBuild,
        "Source changed before WebDriver build",
      );
    }
    const buildStartedAt = new Date().toISOString();
    const buildCommand = [
      "pnpm",
      "--filter",
      "@thechat/desktop",
      "tauri",
      "build",
      "--debug",
      "--no-bundle",
    ];
    if (process.env.SKIP_BUILD !== "1") {
      console.log("Building Tauri binary (set SKIP_BUILD=1 to skip)...");
      execFileSync(buildCommand[0], buildCommand.slice(1), {
          stdio: "inherit",
          cwd: repoRoot,
      });
    }
    const afterBuild = sourceIdentity();
    assertSameIdentity(beforeBuild, afterBuild, "Source changed during WebDriver build");
    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Compiled Tauri binary not found: ${binaryPath}`);
    }
    buildEvidence = {
      schemaVersion: 1,
      runId: RUN_ID,
      git: afterBuild,
      binary: {
        path: binaryPath,
        sha256: sha256File(binaryPath),
      },
      resources: JSON.parse(process.env.THECHAT_E2E_RESOURCE_IDENTITIES ?? "{}"),
      startedAt: process.env.THECHAT_E2E_STARTED_AT ?? buildStartedAt,
      endedAt: new Date().toISOString(),
      buildStartedAt,
      buildCommand,
      testCommand: JSON.parse(
        process.env.THECHAT_E2E_TEST_COMMAND ?? JSON.stringify(process.argv),
      ),
    };
    buildEvidence.resources.tauriDriverPort = TAURI_DRIVER_PORT;
    const buildEvidencePath = process.env.THECHAT_E2E_BUILD_EVIDENCE;
    if (buildEvidencePath) {
      fs.mkdirSync(path.dirname(buildEvidencePath), { recursive: true });
      const pendingBuildEvidencePath = `${buildEvidencePath}.pending-${RUN_ID}`;
      fs.writeFileSync(
        pendingBuildEvidencePath,
        JSON.stringify(buildEvidence, null, 2),
        { flag: "wx" },
      );
      assertSameIdentity(
        buildEvidence.git,
        sourceIdentity(),
        "Build evidence source drift",
      );
      if (sha256File(buildEvidence.binary.path) !== buildEvidence.binary.sha256) {
        throw new Error("Build evidence binary drift before finalization");
      }
      fs.renameSync(pendingBuildEvidencePath, buildEvidencePath);
    }
  },

  async beforeSession(_config, capabilities) {
    verifyBuildBinding("Before WebDriver session");
    // Create isolated data directory so each run gets a fresh SQLite DB.
    // The Rust binary checks THECHAT_DATA_DIR before the default path.
    const configuredDataRoot =
      process.env.THECHAT_E2E_DATA_ROOT?.trim() ||
      process.env.THECHAT_E2E_RUNTIME_ROOT?.trim();
    const dataRoot = configuredDataRoot
      ? path.resolve(configuredDataRoot)
      : path.join(os.homedir(), ".cache", "thechat-e2e", "wdio");
    fs.mkdirSync(dataRoot, { recursive: true });
    tmpDataDir = path.join(dataRoot, `thechat-tauri-e2e-${RUN_ID}`);
    try {
      fs.mkdirSync(tmpDataDir);
    } catch (error) {
      throw new Error(`Refusing Tauri data collision: ${tmpDataDir}`, {
        cause: error,
      });
    }
    fs.writeFileSync(
      path.join(tmpDataDir, OWNER_FILE),
      JSON.stringify({
        owner: "thechat-e2e",
        runId: RUN_ID,
        kind: "tauri-data",
      }),
      { flag: "wx" },
    );
    process.env.THECHAT_DATA_DIR = tmpDataDir;
    prepareNativeOpenerProbe();

    capabilities["tauri:options"] = {
      application: binaryPath,
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
