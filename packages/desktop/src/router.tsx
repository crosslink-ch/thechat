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
import { SearchRoute } from "./routes/search";
import { ActivityRoute } from "./routes/activity";
import { HermesDebugRoute } from "./routes/hermes-debug";
import { ScrollDebugRoute } from "./routes/scroll-debug";
import { SettingsRoute } from "./routes/settings";
import { WorkspaceManageRoute } from "./routes/workspace-manage";
import { BotsManageRoute } from "./routes/bots-manage";

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

function messageSearch(search: Record<string, unknown>): { threadId?: string; messageId?: string; jump?: string } {
  return {
    threadId: typeof search.threadId === "string" ? search.threadId : undefined,
    messageId: typeof search.messageId === "string" ? search.messageId : undefined,
    jump: typeof search.jump === "string" ? search.jump : undefined,
  };
}

const channelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/channel/$id",
  validateSearch: messageSearch,
  component: ChannelRoute,
});

const dmRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dm/$id",
  validateSearch: messageSearch,
  component: DmRoute,
});

const notificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/notifications",
  component: NotificationsRoute,
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  validateSearch: (search: Record<string, unknown>) => ({ q: typeof search.q === "string" ? search.q : "" }),
  component: SearchRoute,
});

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity",
  component: ActivityRoute,
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
  legacyAgentChatRoute,
  legacyAgentChatIdRoute,
  channelRoute,
  dmRoute,
  notificationsRoute,
  activityRoute,
  searchRoute,
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
