import { beforeEach, describe, expect, it } from "vitest";
import { router } from "./router";

describe("production router", () => {
  beforeEach(async () => {
    await router.navigate({ to: "/", replace: true });
  });

  it("redirects the retired workspace LLM configuration route", async () => {
    await router.navigate({ to: "/workspace/manage" });

    expect(router.state.location.pathname).toBe("/");
  });
});