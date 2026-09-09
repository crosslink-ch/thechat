import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const sharedSurfaces = [
  "routes/dm.tsx", "routes/bots-manage.tsx", "routes/workspace-manage.tsx", "routes/settings-api-access.tsx",
  "components/Sidebar.tsx", "components/HermesBotModal.tsx", "components/ChannelChatView.tsx", "components/HermesDmChatView.tsx", "lib/ws-global-handlers.ts",
];
it.each(sharedSurfaces)("shared surface %s cannot require or construct a browser bearer", (path) => {
  const source = readFileSync(`${process.cwd()}/src/${path}`, "utf8");
  expect(source).not.toMatch(/authorization:\s*`Bearer/);
  expect(source).not.toMatch(/!+(?:token|sessionToken)\b/);
  expect(source).not.toMatch(/conversationId && token \?/);
});
