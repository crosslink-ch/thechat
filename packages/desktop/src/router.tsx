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

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WorkspaceHomeRoute,
});

const legacyAgentChatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});

const legacyAgentChatIdRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat/$id",
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
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
  legacyAgentChatRoute,
  legacyAgentChatIdRoute,
  channelRoute,
  dmRoute,
  notificationsRoute,
  settingsRoute,
  workspaceManageRoute,
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
