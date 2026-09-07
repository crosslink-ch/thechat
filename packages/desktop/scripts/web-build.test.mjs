import { test } from "node:test";
import assert from "node:assert/strict";
import { build, resolveConfig } from "vite";
import { readFile } from "node:fs/promises";

test("browser development never probes local desktop DevTools", async () => {
  assert.match(await readFile("src/main.tsx", "utf8"), /if \(import\.meta\.env\.DEV && !__WEB_BUILD__\)/);
});

test("web selection is explicit and desktop remains the default", async () => {
  const web = await resolveConfig({ mode: "web" }, "build");
  const desktop = await resolveConfig({}, "build");
  assert.equal(web.define.__WEB_BUILD__, true);
  assert.equal(desktop.define.__WEB_BUILD__, false);
});

test("production browser graph excludes native startup, tools, OAuth and updater", async () => {
  const modules = [];
  await build({ mode: "web", logLevel: "error", build: { write: false }, plugins: [{
    name: "inspect-browser-graph",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) if (chunk.type === "chunk") modules.push(...Object.keys(chunk.modules));
    },
  }] });
  assert.ok(modules.some(id => id.endsWith("/routes/__root.tsx")), "same shared root");
  assert.deepEqual(modules.filter(id => /\/(desktop-lifecycle|stores\/(tools|codex-auth|updater)|core\/(tools\/|codex|mcp-oauth|skills\/))/.test(id)), []);
});
