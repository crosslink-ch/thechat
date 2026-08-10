#!/usr/bin/env node

import path from "node:path";

const DEV_CONFIG = "src-tauri/tauri.dev.conf.json";
const TAURI_COMMANDS = new Set([
  "init",
  "dev",
  "build",
  "bundle",
  "android",
  "ios",
  "migrate",
  "info",
  "add",
  "remove",
  "plugin",
  "icon",
  "signer",
  "completions",
  "permission",
  "capability",
  "inspect",
  "help",
]);
let args = process.argv.slice(2);

function tauriArgsEnd(argv) {
  const separatorIndex = argv.indexOf("--");
  return separatorIndex === -1 ? argv.length : separatorIndex;
}

function isDevConfigValue(value) {
  if (!value || value.trimStart().startsWith("{")) return false;
  return path.resolve(value) === path.resolve(DEV_CONFIG);
}

function withoutDevConfig(argv) {
  const normalized = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--config" || arg === "-c") {
      const value = argv[index + 1];
      if (value !== undefined) {
        index += 1;
        if (isDevConfigValue(value)) continue;
        normalized.push(arg, value);
        continue;
      }
    }

    const equalsPrefix = ["--config=", "-c="].find((prefix) =>
      arg.startsWith(prefix),
    );
    if (equalsPrefix && isDevConfigValue(arg.slice(equalsPrefix.length))) {
      continue;
    }

    normalized.push(arg);
  }

  return normalized;
}

const argsEnd = tauriArgsEnd(args);
const tauriArgs = args.slice(0, argsEnd);
const separatorAndAppArgs = args.slice(argsEnd);
const command = tauriArgs.find((arg) => TAURI_COMMANDS.has(arg));

if (command === "dev") {
  // Tauri merges config extensions in argv order. Keep the dev identity last so
  // a user-provided config cannot silently restore the production identity.
  args = [
    ...withoutDevConfig(tauriArgs),
    "--config",
    DEV_CONFIG,
    ...separatorAndAppArgs,
  ];
}

if (process.env.THECHAT_TAURI_WRAPPER_PRINT_ARGS === "1") {
  console.log(JSON.stringify(args));
  process.exit(0);
}

let cli;
try {
  cli = await import("@tauri-apps/cli");
  await cli.run(args, "tauri");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (cli?.logError) {
    cli.logError(message);
  } else {
    console.error(message);
  }
  process.exit(1);
}
