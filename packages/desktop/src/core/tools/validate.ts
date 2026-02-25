export type JsonSchema = Record<string, any>;

interface ValidationError {
  path: string;
  message: string;
}

export function validateArgsAgainstSchema(
  schema: JsonSchema | undefined,
  data: unknown,
  options?: { strict?: boolean },
): { valid: true } | { valid: false; errors: ValidationError[] } {
  const strict = options?.strict ?? true;
  if (!schema) return { valid: true };

  // Only handle object-root schemas we use for tools
  if (schema.type !== "object") return { valid: true };
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return {
      valid: false,
      errors: [
        {
          path: "",
          message: `Expected object for arguments, received ${describeType(data)}`,
        },
      ],
    };
  }

  const errors: ValidationError[] = [];

  // Required keys
  const req: string[] = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const key of req) {
    if (!(key in (data as any)) || (data as any)[key] === undefined) {
      errors.push({ path: key, message: `Missing required property '${key}'` });
    }
  }

  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const propSchema = props[key];
    if (!propSchema) {
      if (strict || schema.additionalProperties === false) {
        errors.push({ path: key, message: `Unknown property '${key}'` });
      }
      continue;
    }
    validateValue(propSchema, (data as any)[key], key, errors, strict);
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function validateValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: ValidationError[],
  strict: boolean,
) {
  const t = schema.type as string | string | undefined;
  const types = Array.isArray(t) ? (t as string[]) : t ? [t as string] : [];

  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      errors.push({ path, message: `Expected one of ${JSON.stringify(schema.enum)}, received ${JSON.stringify(value)}` });
      return;
    }
  }

  if (types.length === 0) return; // nothing to validate

  if (types.includes("string")) {
    if (typeof value !== "string") errors.push({ path, message: `Expected string, received ${describeType(value)}` });
    return;
  }
  if (types.includes("number") || types.includes("integer")) {
    if (typeof value !== "number") {
      errors.push({ path, message: `Expected number, received ${describeType(value)}` });
    } else if (types.includes("integer") && !Number.isInteger(value)) {
      errors.push({ path, message: `Expected integer, received ${value}` });
    }
    return;
  }
  if (types.includes("boolean")) {
    if (typeof value !== "boolean") errors.push({ path, message: `Expected boolean, received ${describeType(value)}` });
    return;
  }
  if (types.includes("array")) {
    if (!Array.isArray(value)) {
      errors.push({ path, message: `Expected array, received ${describeType(value)}` });
      return;
    }
    const items = schema.items as JsonSchema | undefined;
    if (items) {
      for (let i = 0; i < value.length; i++) {
        validateValue(items, (value as unknown[])[i], `${path}[${i}]`, errors, strict);
      }
    }
    return;
  }
  if (types.includes("object")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push({ path, message: `Expected object, received ${describeType(value)}` });
      return;
    }
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const req: string[] = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of req) {
      if (!(key in (value as any)) || (value as any)[key] === undefined) {
        errors.push({ path: `${path}.${key}`, message: `Missing required property '${key}'` });
      }
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const ps = props[k];
      if (!ps) {
        if (strict || schema.additionalProperties === false) {
          errors.push({ path: `${path}.${k}`, message: `Unknown property '${k}'` });
        }
        continue;
      }
      validateValue(ps, (value as any)[k], `${path}.${k}`, errors, strict);
    }
    return;
  }
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export function formatValidationErrors(errors: ValidationError[], limit = 3): string {
  if (errors.length === 0) return "Invalid arguments";
  const lines = errors.slice(0, limit).map((e) => `- ${e.path ? `${e.path}: ` : ""}${e.message}`);
  const more = errors.length > limit ? ` (and ${errors.length - limit} more)` : "";
  return `Invalid arguments:\n${lines.join("\n")}${more}`;
}
