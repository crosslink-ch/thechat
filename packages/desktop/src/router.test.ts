import { beforeEach, describe, expect, it } from "vitest";
import { router } from "./router";
import { WorkspaceManageRoute } from "./routes/workspace-manage";
import { AgentChatRoute } from "./routes/agent-chat";

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

  it("restores ACP Agent Chat routes without redirecting to workspace home", async () => {
    await router.navigate({
      to: "/chat",
      search: { projectDir: undefined },
    });
    expect(router.state.location.pathname).toBe("/chat");
    expect(router.routesByPath["/chat"].options.component).toBe(AgentChatRoute);

    await router.navigate({ to: "/chat/$id", params: { id: "acp-conversation" } });
    expect(router.state.location.pathname).toBe("/chat/acp-conversation");
    expect(router.routesByPath["/chat/$id"].options.component).toBe(AgentChatRoute);
  });
});