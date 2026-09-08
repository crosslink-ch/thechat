import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function compareVersions(left, right) {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function readCatalog(path) {
  let releases;
  try {
    releases = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read release notes: ${error.message}`);
  }
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new Error("Release notes must be a non-empty array");
  }
  for (const [index, release] of releases.entries()) {
    if (!release || typeof release !== "object" ||
        typeof release.version !== "string" || !stableVersion.test(release.version) ||
        release.version.includes("\n") ||
        typeof release.title !== "string" || !release.title.trim() ||
        typeof release.body !== "string" || !release.body.trim() ||
        typeof release.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(release.date)) {
      throw new Error(`Invalid release notes entry at index ${index}: version, title, date and body are required`);
    }
    const date = new Date(`${release.date}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== release.date) {
      throw new Error(`Invalid release notes date for ${release.version}`);
    }
    if (index > 0 && compareVersions(releases[index - 1].version, release.version) <= 0) {
      throw new Error("Release notes versions must be unique and ordered newest first");
    }
  }
  return releases;
}

try {
  const [command, ...args] = process.argv.slice(2);
  let catalog = new URL("../release-notes.json", import.meta.url);
  let output;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || (flag !== "--catalog" && flag !== "--github-output")) {
      throw new Error("Usage: release-notes.mjs <vX.Y.Z|--check> [--catalog file] [--github-output file]");
    }
    if (flag === "--catalog") catalog = value;
    else output = value;
  }
  if (command !== "--check" &&
      (typeof command !== "string" || !stableTag.test(command) || command.includes("\n"))) {
    throw new Error("Expected a stable release tag, for example v1.2.3");
  }
  const releases = readCatalog(catalog);
  if (command !== "--check") {
    const release = releases.find((entry) => `v${entry.version}` === command);
    if (!release) throw new Error(`No release notes for ${command}; add an entry to release-notes.json before tagging`);
    if (output) {
      // A random delimiter prevents Markdown lines from injecting workflow outputs.
      let delimiter;
      do { delimiter = `release_notes_${randomUUID()}`; } while (release.body.includes(delimiter));
      appendFileSync(output, `body<<${delimiter}\n${release.body}\n${delimiter}\n`);
    } else {
      process.stdout.write(release.body);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
