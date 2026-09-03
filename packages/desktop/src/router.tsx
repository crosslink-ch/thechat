import {
  createRouter,
  createRootRoute,
  createRoute,
  createHashHistory,
  redirect,
} from "@tanstack/react-router";
import { RootLayout } from "./routes/__root";
import { WorkspaceHomeRoute } from "./routes/workspace-home";
import { ChannelRoute } from "./routes/channel";
import { DmRoute } from "./routes/dm";
import { NotificationsRoute } from "./routes/notifications";
import { HermesDebugRoute } from "./routes/hermes-debug";
import { ScrollDebugRoute } from "./routes/scroll-debug";
import { SettingsRoute } from "./routes/settings";
import { WorkspaceManageRoute } from "./routes/workspace-manage";
import { BotsManageRoute } from "./routes/bots-manage";
import { AgentChatRoute } from "./routes/agent-chat";

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WorkspaceHomeRoute,
});

const agentChatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  component: AgentChatRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    projectDir:
      typeof search.projectDir === "string" ? search.projectDir : undefined,
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

const botsManageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bots/manage",
  component: BotsManageRoute,
});

const scrollDebugRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/debug/scroll",
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      throw redirect({ to: "/" });
    }
  },
  component: ScrollDebugRoute,
});

const hermesDebugRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/debug/hermes",
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      throw redirect({ to: "/" });
    }
  },
  component: HermesDebugRoute,
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
  botsManageRoute,
  scrollDebugRoute,
  hermesDebugRoute,
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
