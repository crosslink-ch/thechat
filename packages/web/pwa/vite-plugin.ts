import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformWithEsbuild, type Plugin } from "vite";

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const SERVICE_WORKER = here("../src/sw/service-worker.ts");
const MANIFEST = here("./manifest.webmanifest");
const ICONS = here("./icons");

/** The worker is a classic script at the site root so its scope is "/". */
export async function compileServiceWorker(): Promise<string> {
  const source = await readFile(SERVICE_WORKER, "utf8");
  const result = await transformWithEsbuild(source, SERVICE_WORKER, {
    loader: "ts",
    format: "iife",
    target: "es2020",
    legalComments: "none",
  });
  return result.code;
}

type Asset = { contentType: string; body: Uint8Array | string };

async function staticAssets(): Promise<Map<string, Asset>> {
  const assets = new Map<string, Asset>([
    ["manifest.webmanifest", { contentType: "application/manifest+json", body: await readFile(MANIFEST, "utf8") }],
  ]);
  for (const file of await readdir(ICONS)) {
    if (!file.endsWith(".png")) continue;
    assets.set(`icons/${file}`, { contentType: "image/png", body: await readFile(path.join(ICONS, file)) });
  }
  return assets;
}

/**
 * Web-only installable-app assets: service worker, manifest and icons. They
 * live outside the shared public directory so the desktop build never ships them.
 */
export function webAppAssets(): Plugin {
  return {
    name: "thechat-web-app-assets",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = (request.url ?? "").split("?")[0]!.replace(/^\//, "");
        try {
          if (pathname === "sw.js") {
            response.setHeader("Content-Type", "text/javascript; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end(await compileServiceWorker());
            return;
          }
          const asset = (await staticAssets()).get(pathname);
          if (!asset) return next();
          response.setHeader("Content-Type", asset.contentType);
          response.setHeader("Cache-Control", "no-cache");
          response.end(asset.body);
        } catch (error) {
          next(error);
        }
      });
    },
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: "sw.js", source: await compileServiceWorker() });
      for (const [fileName, asset] of await staticAssets()) {
        this.emitFile({ type: "asset", fileName, source: asset.body });
      }
    },
  };
}
