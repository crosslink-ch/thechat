import { fromTypes } from "@elysia/openapi";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openApiGeneratorOptions } from "../src/openapi-generation";
import { serializeOpenApiReferences } from "../src/openapi-reference-cache";

const projectRoot = resolve(import.meta.dir, "..");
const outputDirectory = resolve(projectRoot, "dist");
const outputPath = resolve(outputDirectory, "openapi-references.json");
const temporaryPath = `${outputPath}.tmp`;

const generate = fromTypes(
  "src/index.ts",
  openApiGeneratorOptions(projectRoot, false),
);
const references = generate();

if (!references || !references["/health"]?.get?.response?.[200]) {
  throw new Error(
    "OpenAPI type generation did not produce the expected /health response contract",
  );
}

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(temporaryPath, `${serializeOpenApiReferences(references)}\n`);
renameSync(temporaryPath, outputPath);

console.log(
  `Generated OpenAPI type references for ${Object.keys(references).length} paths`,
);
