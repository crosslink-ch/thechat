import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = name => readFileSync(path.join(root, name), "utf8");
const manifest = name => JSON.parse(read(`packages/${name}/package.json`));
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const p = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(p) : /\.[cm]?[jt]sx?$/.test(p) && !/\.test\.|test-setup|test-utils/.test(p) ? [p] : [];
  });
}

test("browser and desktop own independent real entrypoints consuming one client", () => {
  for (const app of ["web", "desktop"]) {
    assert.ok(existsSync(path.join(root, `packages/${app}/src/main.tsx`)), `${app} owns main.tsx`);
    assert.match(read(`packages/${app}/index.html`), /src="\/src\/main.tsx"/);
    assert.match(read(`packages/${app}/src/main.tsx`), /@thechat\/client/);
    assert.equal(manifest(app).dependencies["@thechat/client"], "workspace:*");
  }
  assert.equal(manifest("client").name, "@thechat/client");
  assert.ok(existsSync(path.join(root, "packages/client/src/router.tsx")));
  assert.ok(!existsSync(path.join(root, "packages/desktop/src/router.tsx")), "no duplicated router");
  const scripts = JSON.parse(read("package.json")).scripts;
  assert.match(scripts["build:web"], /--filter @thechat\/web /);
  assert.match(scripts["dev:web"], /--filter @thechat\/web /);
});

test("shared client has no concrete app or native implementation dependency", () => {
  const client = manifest("client");
  assert.deepEqual(Object.keys(client.dependencies).filter(name => /@tauri|@thechat\/(web|desktop)/.test(name)), []);
  for (const file of sources(path.join(root, "packages/client/src"))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /(?:from\s*|import\s*\()\s*["'][^"']*(?:@tauri-apps|@thechat\/(?:desktop|web)|(?:\.\.\/)+(?:desktop|web)\/)/, file);
  }
  assert.doesNotMatch(read("packages/client/tsconfig.json"), /desktop|packages\/web|\.\.\/web/);
});
