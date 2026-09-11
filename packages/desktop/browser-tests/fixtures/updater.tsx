import React from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { mockIPC } from "@tauri-apps/api/mocks";
import { Sidebar } from "@thechat/client/components/Sidebar";
import { AppViewport } from "@thechat/client/components/AppViewport";
import { ResponsiveShell, NavigationToggle } from "@thechat/client/components/ResponsiveShell";
import { useAuthStore } from "@thechat/client/stores/auth";
import { useWorkspacesStore } from "@thechat/client/stores/workspaces";
import { useUpdaterStore } from "../../src/stores/updater";
import { UpdateToast } from "../../src/components/UpdateToast";
import "../../src/desktop.css";

// Synthetic identity and native boundary only. Render the real sidebar, store,
// toast and updater JS plugin; never connect to a backend or install an artifact.
let finishDownload: () => void = () => {};
let finishInstall: () => void = () => {};
const calls: string[] = [];
mockIPC(async (command, args: any) => {
  calls.push(command);
  if (command === "plugin:app|version") return "1.0.0";
  if (command === "plugin:updater|check") return {
    rid: 1, version: "2.0.0", currentVersion: "1.0.0", rawJson: {},
  };
  if (command === "plugin:updater|download") {
    args.onEvent.onmessage({ event: "Started", data: { contentLength: 100 } });
    args.onEvent.onmessage({ event: "Progress", data: { chunkLength: 42 } });
    await new Promise<void>((resolve) => { finishDownload = resolve; });
    args.onEvent.onmessage({ event: "Finished" });
    return 2;
  }
  if (command === "plugin:updater|install") {
    await new Promise<void>((resolve) => { finishInstall = resolve; });
  }
});

const user = { id: "review-user", name: "Alex Example", email: "alex@example.invalid", avatar: null, type: "human" as const };
useAuthStore.setState({ user, token: "synthetic-review-token", loading: false });
const workspace = { id: "review-workspace", name: "Update review", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
useWorkspacesStore.setState({
  workspaces: [{ ...workspace, role: "owner" }],
  activeWorkspace: {
    ...workspace,
    members: [{ userId: user.id, role: "owner", joinedAt: "2026-01-01", user }],
    channels: Array.from({ length: 40 }, (_, i) => ({
      id: `review-channel-${i}`, workspaceId: workspace.id,
      name: `channel-${i + 1}`, title: `Channel ${i + 1}`,
      createdAt: "2026-01-01", updatedAt: "2026-01-01",
    })),
  },
});

(window as any).updateReview = {
  begin: () => useUpdaterStore.getState().checkForUpdates(),
  finishDownload: () => finishDownload(),
  finishInstall: () => finishInstall(),
  fail: () => useUpdaterStore.setState({ downloaded: false, downloading: false, error: "Failed to download update" }),
  calls,
};
const rootRoute = createRootRoute({ component: () => (
  <AppViewport className="flex flex-col bg-base">
    <ResponsiveShell navigation={<Sidebar />} routeKey="review">
      <main className="p-6 text-text">
        <NavigationToggle />
        <h1 className="text-xl font-semibold">Update indicator review</h1>
        <p className="mt-3 max-w-lg text-text-muted">Real sidebar and updater UI with a simulated native updater. No backend connection or actual installation.</p>
        <button className="mt-4 rounded-md bg-accent px-3 py-2 text-white" onClick={() => void useUpdaterStore.getState().checkForUpdates()}>Simulate available update</button>
        <button className="ml-2 rounded-md bg-raised px-3 py-2" onClick={() => finishDownload()}>Finish download</button>
      </main>
    </ResponsiveShell>
    <UpdateToast />
  </AppViewport>
) });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]), history: createMemoryHistory() });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
