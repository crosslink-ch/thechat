import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = fileURLToPath(new URL("./release-notes.mjs", import.meta.url));
const catalogPath = fileURLToPath(new URL("../release-notes.json", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const entry = (version = "1.2.0") => ({ version, title: "A release", date: "2026-09-08", body: "## New\n\n- A feature\n" });
function fixture(t, data) {
  const dir = mkdtempSync(join(tmpdir(), "thechat-release-notes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "notes.json");
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  return { dir, file };
}

test("release command emits the exact bundled notes for a release tag", () => {
  const expected = JSON.parse(readFileSync(catalogPath, "utf8"))[0];
  const result = run(`v${expected.version}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, expected.body);
});

test("catalog validation is runnable without publishing a release", () => {
  const result = run("--check");
  assert.equal(result.status, 0, result.stderr);
});

for (const tag of ["main", "0.9.0", "v01.2.3", "v1.2.3-beta.1", "v1.2.3\n", "v1.2.3\r"]) {
  test(`rejects invalid or non-stable release tag ${JSON.stringify(tag)}`, () => {
    const result = run(tag);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stable release tag/);
    assert.equal(result.stdout, "");
  });
}

test("requires notes for the exact version instead of falling back to latest", () => {
  const result = run("v999.0.0");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No release notes for v999.0.0/);
  assert.equal(result.stdout, "");
});

test("can re-release a historical version using its own notes", (t) => {
  const older = { ...entry("1.1.0"), body: "Older release notes\n" };
  const { file } = fixture(t, [entry(), older]);
  const result = run("v1.1.0", "--catalog", file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, older.body);
});

const invalidCatalogs = [
  ["empty catalog", []],
  ["non-array catalog", {}],
  ["null entry", [null]],
  ["duplicate versions", [entry(), entry()]],
  ["oldest-first versions", [entry("1.9.0"), entry("1.10.0")]],
  ["blank title", [{ ...entry(), title: "  " }]],
  ["blank body", [{ ...entry(), body: "\n" }]],
  ["invalid version", [entry("v1.2.0")]],
  ["invalid date", [{ ...entry(), date: "2026-02-30" }]],
  ["malformed JSON", "not json"],
];
for (const [name, data] of invalidCatalogs) {
  test(`fails closed for ${name}`, (t) => {
    const { file } = fixture(t, data);
    const result = run("--check", "--catalog", file);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /release notes/i);
  });
}

test("orders versions numerically, not lexically", (t) => {
  const { file } = fixture(t, [entry("1.10.0"), entry("1.9.0")]);
  const result = run("--check", "--catalog", file);
  assert.equal(result.status, 0, result.stderr);
});

test("writes multiline release notes safely to the GitHub output file", (t) => {
  const body = "## Changes\n\n- Unicode: café\nEOF\nbody=fake\n${{ secrets.TEST }}\n";
  const { dir, file } = fixture(t, [{ ...entry(), body }]);
  const output = join(dir, "github-output");
  writeFileSync(output, "existing=true\n");
  const result = run("v1.2.0", "--catalog", file, "--github-output", output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const written = readFileSync(output, "utf8");
  const match = /^existing=true\nbody<<([^\n]+)\n([\s\S]*)\n\1\n$/.exec(written);
  assert.ok(match, written);
  assert.equal(match[2], body);
});

test("web release builds include the catalog in their context and image", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  assert.match(read("deploy/web/Dockerfile.dockerignore"), /^!release-notes\.json$/m);
  assert.match(read("deploy/web/Dockerfile"), /^COPY release-notes\.json \.\/$/m);
  assert.match(read(".github/workflows/web-image.yml"), /- "release-notes\.json"/);
});

test("does not write GitHub outputs when validation fails", (t) => {
  const { dir, file } = fixture(t, [{ ...entry(), body: "" }]);
  const output = join(dir, "github-output");
  writeFileSync(output, "existing=true\n");
  const result = run("v1.2.0", "--catalog", file, "--github-output", output);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(output, "utf8"), "existing=true\n");
});
