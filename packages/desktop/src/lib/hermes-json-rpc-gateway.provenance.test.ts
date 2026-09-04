import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const sourcePath = resolve(
  process.cwd(),
  "src/lib/hermes-json-rpc-gateway.ts",
);
const licensePath = resolve(
  process.cwd(),
  "src/lib/hermes-json-rpc-gateway.LICENSE",
);

describe("Hermes JSON-RPC gateway source provenance", () => {
  test("keeps the mirrored upstream body pinned to the declared digest", () => {
    const source = readFileSync(sourcePath, "utf8");
    const expectedDigest = source.match(
      /Upstream SHA-256: ([a-f0-9]{64})\./,
    )?.[1];
    const bodyStart = source.indexOf("export type GatewayEventName");

    expect(expectedDigest).toBeDefined();
    expect(bodyStart).toBeGreaterThan(0);

    const actualDigest = createHash("sha256")
      .update(source.slice(bodyStart))
      .digest("hex");
    expect(actualDigest).toBe(expectedDigest);
  });

  test("retains the upstream commit attribution and MIT notice", () => {
    const license = readFileSync(licensePath, "utf8");

    expect(license).toContain("63279301bcbdc185c1b07b98a9312eb0c862f26d");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2025 Nous Research");
  });
});
