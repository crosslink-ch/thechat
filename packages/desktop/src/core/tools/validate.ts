import Ajv, { type ErrorObject } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Validate tool call arguments against a JSON schema.
 * Returns an error message string if invalid, or `null` if valid.
 */
export function validateToolArgs(schema: Record<string, any> | undefined, args: unknown): string | null {
  if (!schema || schema.type !== "object") return null;

  if (ajv.validate(schema, args)) return null;

  const errors = (ajv.errors ?? []).map(formatAjvError);
  const lines = errors.slice(0, 3).map((e) => `- ${e}`);
  const more = errors.length > 3 ? ` (and ${errors.length - 3} more)` : "";
  return `Invalid arguments:\n${lines.join("\n")}${more}`;
}

function formatAjvError(e: ErrorObject): string {
  const path = e.instancePath.replace(/^\//, "").replace(/\//g, ".");

  switch (e.keyword) {
    case "required": {
      const full = path ? `${path}.${e.params.missingProperty}` : e.params.missingProperty;
      return `${full}: Missing required property '${e.params.missingProperty}'`;
    }
    case "additionalProperties": {
      const full = path ? `${path}.${e.params.additionalProperty}` : e.params.additionalProperty;
      return `${full}: Unknown property '${e.params.additionalProperty}'`;
    }
    case "type":
      return `${path}: Expected ${e.params.type}, received ${describeType(e.data)}`;
    case "enum":
      return `${path}: Expected one of ${JSON.stringify(e.params.allowedValues)}, received ${JSON.stringify(e.data)}`;
    default:
      return path ? `${path}: ${e.message}` : (e.message ?? "Validation failed");
  }
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
