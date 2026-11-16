import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, createServer } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Starts the web Vite config on an ephemeral loopback port for one test file.
 *
 * HMR is off, so a page cannot recover if Vite discovers dependencies after it
 * loaded (it answers "504 Outdated Optimize Dep" and the page stays blank).
 * Dependencies must therefore be found by the startup scan:
 * - `entries` limits the scan to the pages this file opens, so a broken
 *   fixture elsewhere cannot disable pre-bundling for every file;
 * - a failed scan fails here, with Vite's reason, instead of as 30 s
 *   locator timeouts in unrelated tests.
 * The dependency cache is private to the server and removed on close.
 */
export async function startViteServer({ entries, mode } = {}) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "thechat-browser-vite-"));
  const logger = createLogger("error");
  const logged = [];
  const error = logger.error;
  logger.error = (message, options) => {
    logged.push(String(message));
    error(message, options);
  };
  let server;
  try {
    server = await createServer({
      root,
      configFile: path.join(root, "vite.config.ts"),
      cacheDir,
      mode,
      customLogger: logger,
      optimizeDeps: entries ? { entries } : undefined,
      server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    });
    await server.listen();
    await server.environments.client.depsOptimizer?.scanProcessing;
    const scanFailure = logged.find((message) => message.includes("Failed to run dependency scan"));
    if (scanFailure) throw new Error(`Vite could not pre-bundle browser-test dependencies:\n${scanFailure}`);
  } catch (cause) {
    await server?.close();
    await fs.rm(cacheDir, { recursive: true, force: true });
    throw cause;
  }
  return {
    baseUrl: `http://127.0.0.1:${server.httpServer.address().port}`,
    async close() {
      await server.close();
      await fs.rm(cacheDir, { recursive: true, force: true });
    },
  };
}
