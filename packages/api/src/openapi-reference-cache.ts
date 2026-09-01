const SYMBOLS_KEY = "__thechatTypeBoxSymbols";

type SymbolMetadata = Record<string, unknown>;
type ReferenceObject = Record<PropertyKey, unknown>;

export function serializeOpenApiReferences(references: unknown): string {
  return JSON.stringify(
    references,
    (_key, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return value;

      const object = value as ReferenceObject;
      const symbols = Object.getOwnPropertySymbols(object);
      if (symbols.length === 0) return value;
      if (SYMBOLS_KEY in object) {
        throw new Error(
          `Reserved OpenAPI cache key is already present: ${SYMBOLS_KEY}`,
        );
      }

      const metadata: SymbolMetadata = {};
      for (const symbol of symbols) {
        const name = Symbol.keyFor(symbol);
        if (!name)
          throw new Error("OpenAPI references contain a non-global symbol");
        metadata[name] = object[symbol];
      }
      return { ...object, [SYMBOLS_KEY]: metadata };
    },
    2,
  );
}

export function parseOpenApiReferences<T = Record<string, unknown>>(
  json: string,
): T {
  return JSON.parse(json, (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value;

    const object = value as ReferenceObject;
    const metadata = object[SYMBOLS_KEY] as SymbolMetadata | undefined;
    if (!metadata) return value;

    delete object[SYMBOLS_KEY];
    for (const [name, symbolValue] of Object.entries(metadata)) {
      Object.defineProperty(object, Symbol.for(name), {
        configurable: true,
        enumerable: true,
        value: symbolValue,
      });
    }
    return object;
  }) as T;
}
