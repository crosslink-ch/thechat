import { describe, expect, test } from "bun:test";
import { createApplicationLogger } from "./logging";

describe("application logger", () => {
  test("uses the configured log level", () => {
    expect(createApplicationLogger("warn").level).toBe("warn");
  });

  test("supports component-scoped child loggers", () => {
    const logger = createApplicationLogger("silent").child({
      component: "test-component",
    });

    expect(logger.bindings()).toEqual({ component: "test-component" });
  });
});
