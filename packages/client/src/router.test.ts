import { beforeEach, describe, expect, it } from "vitest";
import { router } from "./router";
import { WorkspaceManageRoute } from "./routes/workspace-manage";
import { ActivityRoute } from "./routes/activity";

describe("production router", () => {
  beforeEach(async () => {
    await router.navigate({ to: "/", replace: true });
  });

  it("keeps the workspace access management route available", async () => {
    await router.navigate({ to: "/workspace/manage" });
    expect(router.state.location.pathname).toBe("/workspace/manage");
    expect(router.routesByPath["/workspace/manage"].options.component).toBe(
      WorkspaceManageRoute,
    );
  });

  it("exposes the cross-workspace Activity view", async () => {
    await router.navigate({ to: "/activity" });
    expect(router.state.location.pathname).toBe("/activity");
    expect(router.routesByPath["/activity"].options.component).toBe(ActivityRoute);
  });
});