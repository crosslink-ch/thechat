import { fromTypes, openapi } from "@elysia/openapi";
import type { ElysiaOpenAPIConfig } from "@elysia/openapi";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import apiPackage from "../package.json" with { type: "json" };
import {
  API_TAG_DEFINITIONS,
  API_TAGS,
  BEARER_AUTH_SECURITY,
} from "./openapi-metadata";
import { openApiGeneratorOptions } from "./openapi-generation";
import { parseOpenApiReferences } from "./openapi-reference-cache";

type GeneratedReferences = NonNullable<
  ReturnType<ReturnType<typeof fromTypes>>
>;

const SCALAR_CONFIGURATION = {
  telemetry: false,
  version: "1.67.0",
} as NonNullable<ElysiaOpenAPIConfig["scalar"]>;

function typeReferences(projectRoot: string) {
  const sourcePath = resolve(projectRoot, "src/index.ts");
  const bundledReferencesPath = resolve(
    import.meta.dir,
    "openapi-references.json",
  );
  const generatedPath = existsSync(bundledReferencesPath)
    ? bundledReferencesPath
    : resolve(projectRoot, "dist/openapi-references.json");
  if (existsSync(bundledReferencesPath) || !existsSync(sourcePath)) {
    if (!existsSync(generatedPath)) {
      throw new Error(
        "Generated OpenAPI references are missing from the API build output",
      );
    }
    const references = parseOpenApiReferences<GeneratedReferences>(
      readFileSync(generatedPath, "utf8"),
    );
    if (!references["/health"]?.get?.response?.[200]) {
      throw new Error("Generated OpenAPI references are invalid");
    }
    return () => references;
  }

  return fromTypes("src/index.ts", openApiGeneratorOptions(projectRoot, true));
}

function apiProjectRoot() {
  const candidates = [
    resolve(process.cwd(), "packages/api"),
    process.cwd(),
    resolve(import.meta.dir, ".."),
  ];

  const projectRoot = candidates.find(
    (candidate) =>
      existsSync(resolve(candidate, "src/index.ts")) ||
      existsSync(resolve(candidate, "dist/openapi-references.json")),
  );
  if (!projectRoot) {
    throw new Error("Unable to locate the @thechat/api package root");
  }
  return projectRoot;
}

export function apiDocumentation() {
  const projectRoot = apiProjectRoot();

  return openapi({
    path: "/docs",
    specPath: "/openapi.json",
    exclude: {
      paths: ["/ws"],
    },
    scalar: SCALAR_CONFIGURATION,
    references: typeReferences(projectRoot),
    documentation: {
      info: {
        title: "TheChat API",
        version: apiPackage.version,
        description: [
          "Interactive OpenAPI documentation generated from TheChat's live Elysia route tree.",
          "",
          "Send human session tokens, personal access tokens, and bot API keys as `Authorization: Bearer <token>`. Personal access tokens start with `tchat_pat_`; bot API keys start with `bot_`.",
          "",
          "OpenAPI describes the HTTP API and MCP transport. Realtime clients connect to `/ws`; that WebSocket protocol authenticates with its first message and is intentionally not represented as an HTTP operation.",
        ].join("\n"),
      },
      externalDocs: {
        description: "TheChat personal access token guide",
        url: "https://github.com/crosslink-ch/thechat/blob/main/docs/personal-access-tokens.md",
      },
      tags: API_TAG_DEFINITIONS,
      security: BEARER_AUTH_SECURITY,
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "TheChat session, PAT, or bot token",
            description:
              "Use the token returned by human login, a `tchat_pat_` personal access token, or a `bot_` bot API key where that principal type is supported.",
          },
        },
      },
      paths: {
        "/mcp": {
          post: {
            operationId: "callMcp",
            summary: "Call the stateless MCP server",
            description:
              "Send a JSON-RPC 2.0 request using the MCP Streamable HTTP transport.",
            tags: [API_TAGS.mcp],
            security: BEARER_AUTH_SECURITY,
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    description: "An MCP JSON-RPC 2.0 request.",
                    additionalProperties: true,
                  },
                },
              },
            },
            responses: {
              "200": {
                description: "An MCP JSON-RPC response or event stream.",
              },
              "401": {
                description: "The bearer token is missing or invalid.",
              },
              "405": {
                description:
                  "Only POST is supported by this stateless transport.",
              },
            },
          },
        },
      },
    },
  });
}
