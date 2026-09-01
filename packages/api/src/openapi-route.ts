import type { DocumentDecoration } from "elysia";
import { z } from "zod";

export const SENSITIVE_STRING_METADATA = {
  format: "password",
  writeOnly: true,
} as const;

export function jsonBodyDocumentation(
  summary: string,
  schema: z.ZodType,
): DocumentDecoration {
  const { $schema: _metaSchema, ...openApiSchema } = z.toJSONSchema(schema, {
    io: "input",
    reused: "inline",
    target: "openapi-3.0",
    unrepresentable: "any",
  });

  return {
    summary,
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: openApiSchema,
        },
      },
    },
  } as DocumentDecoration;
}
