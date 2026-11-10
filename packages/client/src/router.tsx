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
import { ActivityRoute } from "./routes/activity";
import { ThreadsRoute } from "./routes/threads";
import { InboxRoute } from "./routes/inbox";
import { HermesDebugRoute } from "./routes/hermes-debug";
import { ScrollDebugRoute } from "./routes/scroll-debug";
import { SettingsRoute } from "./routes/settings";
import { WorkspaceManageRoute } from "./routes/workspace-manage";
import { BotsManageRoute } from "./routes/bots-manage";
import { OpenConversationRoute, validateOpenSearch } from "./routes/open";
import { SearchRoute, validateSearchRouteSearch } from "./routes/search";
import { MessageContextRoute } from "./routes/message";

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

/** Opens a reply thread in the side panel (and highlights one of its replies). */
function replyThreadSearch(search: Record<string, unknown>): {
  replyThread?: string;
  replyMessage?: string;
} {
  const id = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
  const replyThread = id(search.replyThread);
  const replyMessage = replyThread ? id(search.replyMessage) : undefined;
  return {
    ...(replyThread ? { replyThread } : {}),
    ...(replyMessage ? { replyMessage } : {}),
  };
}

const channelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/channel/$id",
  validateSearch: (search: Record<string, unknown>) => replyThreadSearch(search),
  component: ChannelRoute,
});

const dmRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dm/$id",
  validateSearch: (search: Record<string, unknown>) => ({
    threadId: typeof search.threadId === "string" ? search.threadId : undefined,
    ...replyThreadSearch(search),
  }),
  component: DmRoute,
});

const notificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/notifications",
  component: NotificationsRoute,
});

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity",
  component: ActivityRoute,
});

const threadsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/threads",
  component: ThreadsRoute,
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: InboxRoute,
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

// Where a tapped background notification lands (see the web service worker).
const openRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/open",
  validateSearch: validateOpenSearch,
  component: OpenConversationRoute,
});

// Full message search results; filters live in the URL.
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  validateSearch: validateSearchRouteSearch,
  component: SearchRoute,
});

// One message in its conversation: search results and shared message links.
const messageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/message/$messageId",
  component: MessageContextRoute,
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
  threadsRoute,
  inboxRoute,
  settingsRoute,
  workspaceManageRoute,
  botsManageRoute,
  openRoute,
  searchRoute,
  messageRoute,
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
