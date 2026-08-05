import { beforeEach, describe, expect, it } from "vitest";
import { router } from "./router";

describe("production router", () => {
  beforeEach(async () => {
    await router.navigate({ to: "/", replace: true });
  });

  it("keeps the workspace access management route available", async () => {
    await router.navigate({ to: "/workspace/manage" });

    expect(router.state.location.pathname).toBe("/workspace/manage");
  });
});