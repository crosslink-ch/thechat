import {
  createRouter,
  createRootRoute,
  createRoute,
  createHashHistory,
  redirect,
} from "@tanstack/react-router";
import { RootLayout } from "./routes/__root";
import { AgentChatRoute } from "./routes/agent-chat";
import { ChannelRoute } from "./routes/channel";
import { DmRoute } from "./routes/dm";
import { NotificationsRoute } from "./routes/notifications";
import { SettingsRoute } from "./routes/settings";
import { WorkspaceManageRoute } from "./routes/workspace-manage";

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/chat" });
  },
});

const agentChatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  component: AgentChatRoute,
  validateSearch: (search: Record<string, unknown>): { projectDir?: string } => ({
    projectDir: (search.projectDir as string) || undefined,
  }),
});

const agentChatIdRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat/$id",
  component: AgentChatRoute,
});

const channelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/channel/$id",
  component: ChannelRoute,
});

const dmRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dm/$id",
  component: DmRoute,
});

const notificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/notifications",
  component: NotificationsRoute,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsRoute,
});

const workspaceManageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspace/manage",
  component: WorkspaceManageRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  agentChatRoute,
  agentChatIdRoute,
  channelRoute,
  dmRoute,
  notificationsRoute,
  settingsRoute,
  workspaceManageRoute,
]);

const hashHistory = createHashHistory();

export const router = createRouter({
  routeTree,
  history: hashHistory,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
