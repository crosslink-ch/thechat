import { test } from "node:test";
import assert from "node:assert/strict";
import { build, resolveConfig } from "vite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = p => fileURLToPath(new URL(p, import.meta.url));
const webConfig = here("../vite.config.ts");
const desktopConfig = here("../../desktop/vite.config.ts");

test("browser document has product branding and a zoomable phone viewport", async () => {
  const html = await readFile(here("../index.html"), "utf8");
  assert.match(html, /href="\/thechat\.png"/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /interactive-widget=resizes-content/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
  const icon = await readFile(here("../../client/public/thechat.png"));
  assert.ok(icon.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
});

test("browser development never probes local desktop DevTools", async () => {
  assert.doesNotMatch(await readFile(here("../src/main.tsx"), "utf8"), /8097|DevTools/);
  assert.doesNotMatch(await readFile(here("../../client/src/index.tsx"), "utf8"), /8097|DevTools/);
  assert.match(await readFile(here("../../desktop/src/main.tsx"), "utf8"), /if \(import\.meta\.env\.DEV && !__WEB_BUILD__\)/);
});

test("web selection is explicit and desktop remains the default", async () => {
  const web = await resolveConfig({ configFile: webConfig }, "build");
  const desktop = await resolveConfig({ configFile: desktopConfig }, "build");
  assert.equal(web.define.__WEB_BUILD__, true);
  assert.equal(desktop.define.__WEB_BUILD__, false);
  assert.equal(web.build.outDir, "dist");
  assert.equal(desktop.build.outDir, "dist");
  assert.notEqual(web.root, desktop.root);
});

for (const app of ["web", "desktop"]) test(`${app} graph preserves one shared application, assets and platform boundaries`, async () => {
  const modules = new Set();
  const parsed = new Set();
  let css = "";
  await build({ configFile: app === "web" ? webConfig : desktopConfig, logLevel: "error", build: { write: false }, plugins: [{
    name: "inspect-client-graph",
    moduleParsed(info) { parsed.add(info.id); },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === "chunk") for (const id of Object.keys(chunk.modules)) modules.add(id);
        if (chunk.type === "asset" && chunk.fileName.endsWith(".css")) css += chunk.source;
      }
    },
  }] });
  for (const singleton of ["router.tsx", "stores/auth.ts", "lib/query-client.ts", "stores/composer-drafts.ts"]) {
    assert.equal([...modules].filter(id => id.endsWith(`/client/src/${singleton}`)).length, 1, singleton);
  }
  assert.ok([...modules].some(id => id.endsWith("/client/src/routes/__root.tsx")), "same shared root");
  assert.match(css, /\.bg-surface\{/);
  assert.match(css, /\.app-viewport/);
  if (app === "web") {
    assert.deepEqual([...parsed].filter(id => /@tauri-apps|\/packages\/desktop\//.test(id)), [], "not even parsed/tree-shaken native imports");
    assert.deepEqual([...modules].filter(id => /\/(desktop-lifecycle|stores\/(tools|codex-auth|updater)|core\/(tools\/|codex|mcp-oauth|skills\/))/.test(id)), []);
  } else {
    assert.ok([...modules].some(id => id.endsWith("/desktop/src/desktop-lifecycle.ts")));
    assert.ok([...modules].some(id => id.endsWith("/desktop/src/stores/updater.ts")));
    assert.match(css, /width:112px/, "desktop titlebar utility is discovered outside shared client");
  }
});
