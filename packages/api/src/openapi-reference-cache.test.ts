import { expect, test } from "bun:test";
import {
  parseOpenApiReferences,
  serializeOpenApiReferences,
} from "./openapi-reference-cache";

const kind = Symbol.for("TypeBox.Kind");
const optional = Symbol.for("TypeBox.Optional");

test("preserves TypeBox metadata in cached OpenAPI references", () => {
  const source = {
    schema: {
      [kind]: "Object",
      type: "object",
      properties: {
        name: { [kind]: "String", [optional]: "Optional", type: "string" },
      },
    },
  };

  const restored = parseOpenApiReferences(serializeOpenApiReferences(source));
  const schema = restored.schema as typeof source.schema;
  const name = schema.properties.name;

  expect(schema[kind]).toBe("Object");
  expect(name[kind]).toBe("String");
  expect(name[optional]).toBe("Optional");
  expect(Object.keys(schema)).toEqual(["type", "properties"]);
  expect(Object.keys(name)).toEqual(["type"]);
});
