import { describe, expect, test } from "bun:test";
import { app } from "./index";

type OpenApiDocument = {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  tags?: Array<{ name: string; description?: string }>;
  components?: {
    securitySchemes?: Record<string, { type?: string; scheme?: string }>;
  };
  security?: Array<Record<string, string[]>>;
  paths: Record<
    string,
    Record<
      string,
      {
        tags?: string[];
        summary?: string;
        security?: Array<Record<string, string[]>>;
        responses?: Record<
          string,
          { content?: Record<string, { schema?: unknown }> }
        >;
        requestBody?: {
          required?: boolean;
          content?: Record<
            string,
            { schema?: { properties?: Record<string, unknown> } }
          >;
        };
      }
    >
  >;
};

async function request(path: string) {
  return app.handle(new Request(`http://localhost${path}`));
}

async function openApiDocument() {
  const response = await request("/openapi.json");
  expect(response.status).toBe(200);
  return (await response.json()) as OpenApiDocument;
}

describe("generated API documentation", () => {
  test("serves Scalar and a raw OpenAPI document", async () => {
    const docsResponse = await request("/docs");
    expect(docsResponse.status).toBe(200);
    expect(docsResponse.headers.get("content-type")).toContain("text/html");
    const docsHtml = await docsResponse.text();
    expect(docsHtml).toContain("TheChat API");
    expect(docsHtml).toContain("@scalar/api-reference@1.67.0");
    expect(docsHtml).toContain('"telemetry":false');

    const specResponse = await request("/openapi.json");
    expect(specResponse.status).toBe(200);
    expect(specResponse.headers.get("content-type")).toContain(
      "application/json",
    );

    const spec = (await specResponse.json()) as OpenApiDocument;
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.info.title).toBe("TheChat API");
    expect(spec.info.version).toBe("0.1.0");
    expect(spec.info.description).toContain("generated");
    expect(spec.paths["/health"]).toBeDefined();
  });

  test("groups every documented operation and explains authentication", async () => {
    const spec = await openApiDocument();
    const bearerAuth = spec.components?.securitySchemes?.bearerAuth;

    expect(bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    const publicOperations = [
      spec.paths["/"].get,
      spec.paths["/health"].get,
      spec.paths["/auth/register"].post,
      spec.paths["/auth/login"].post,
      spec.paths["/auth/verify-email"].post,
      spec.paths["/auth/resend-verification"].post,
      spec.paths["/auth/request-password-reset"].post,
      spec.paths["/auth/reset-password"].post,
    ];
    for (const operation of publicOperations) {
      expect(operation.security ?? []).toEqual([]);
    }
    const messageSecurity =
      spec.paths["/messages/{conversationId}"].post.security ?? spec.security;
    expect(messageSecurity).toContainEqual({ bearerAuth: [] });

    expect(Object.keys(spec.paths["/mcp"])).toEqual(["post"]);
    expect(spec.paths["/ws"]).toBeUndefined();

    const declaredTags = new Set(spec.tags?.map(({ name }) => name));
    expect(declaredTags.size).toBeGreaterThan(0);
    for (const tag of spec.tags ?? []) {
      expect(tag.description?.length ?? 0).toBeGreaterThan(0);
    }

    const methods = new Set([
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "head",
      "options",
    ]);
    for (const pathItem of Object.values(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!methods.has(method)) continue;
        expect(operation.tags?.length ?? 0).toBeGreaterThan(0);
        for (const tag of operation.tags ?? []) {
          expect(declaredTags.has(tag)).toBe(true);
        }
      }
    }
  });

  test("stays in sync with HTTP routes and includes inferred response contracts", async () => {
    const spec = await openApiDocument();
    const documentedMethods = new Set([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ]);
    const intentionallySeparatePaths = new Set([
      "/docs",
      "/openapi.json",
      "/mcp",
      "/ws",
    ]);

    for (const route of app.routes) {
      if (!documentedMethods.has(route.method)) continue;
      if (intentionallySeparatePaths.has(route.path)) continue;

      const openApiPath = route.path.replace(/:([^/]+)/g, "{$1}");
      expect(
        spec.paths[openApiPath]?.[route.method.toLowerCase()],
      ).toBeDefined();
    }

    const healthResponseSchema =
      spec.paths["/health"].get.responses?.["200"]?.content?.[
        "application/json"
      ]?.schema;
    expect(healthResponseSchema).toBeDefined();
  });

  test("exposes request contracts for common automation flows", async () => {
    const spec = await openApiDocument();
    const cases = [
      ["/auth/login", "post", ["email", "password"]],
      ["/workspaces/create", "post", ["name"]],
      ["/messages/{conversationId}", "post", ["content"]],
    ] as const;

    for (const [path, method, properties] of cases) {
      const requestBody = spec.paths[path]?.[method]?.requestBody;
      const schema = requestBody?.content?.["application/json"]?.schema;
      expect(requestBody?.required, `${method.toUpperCase()} ${path}`).toBe(
        true,
      );
      for (const property of properties) {
        expect(
          schema?.properties,
          `${method.toUpperCase()} ${path}`,
        ).toHaveProperty(property);
      }
    }

    const requestOperations = Object.values(spec.paths).flatMap((pathItem) =>
      Object.values(pathItem).filter((operation) => operation.requestBody),
    );
    expect(requestOperations.length).toBeGreaterThanOrEqual(35);
    for (const operation of requestOperations) {
      expect(operation.summary?.length ?? 0).toBeGreaterThan(0);
      expect(
        operation.requestBody?.content?.["application/json"]?.schema,
      ).toBeDefined();
    }

    const loginProperties =
      spec.paths["/auth/login"].post.requestBody?.content?.["application/json"]
        ?.schema?.properties;
    expect(loginProperties?.password).toMatchObject({
      format: "password",
      writeOnly: true,
    });

    const providerProperties =
      spec.paths["/workspaces/{id}/config/openrouter"].put.requestBody
        ?.content?.["application/json"]?.schema?.properties;
    expect(providerProperties?.apiKey).toMatchObject({
      format: "password",
      writeOnly: true,
    });
  });
});
