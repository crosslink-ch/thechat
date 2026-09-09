import { chromium, webkit } from "playwright";
import { createServer } from "vite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
// Real web entrypoint, router and components with synthetic HTTP/WebSocket fixtures.
// This is UI integration coverage, not live authentication/API/bot E2E.
test(
  "context header, task actions and navigation fit desktop and mobile",
  { timeout: 180000 },
  async (t) => {
    const out =
      process.env.TOPBAR_ARTIFACTS_DIR ||
      path.join(os.homedir(), ".cache/thechat/topbar-tests");
    await fs.mkdir(out, { recursive: true });
    const root = fileURLToPath(new URL("../", import.meta.url));
    const server = await createServer({
      root,
      cacheDir: path.join(out, "vite-cache"),
      configFile: path.join(root, "vite.config.ts"),
      mode: "web",
      server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
      logLevel: "error",
    });
    await server.listen();
    t.after(() => server.close());
    const date = "2026-09-09T12:00:00.000Z";
    const self = {
      id: "review-user",
      name: "Alex Morgan",
      email: "alex@example.test",
      type: "human",
    };
    const bot = { id: "review-bot-user", name: "Hermes", type: "bot" };
    const human = { id: "review-human", name: "Jamie Chen", type: "human" };
    const workspace = {
      id: "review-workspace",
      name: "Product studio",
      role: "owner",
      createdAt: date,
      updatedAt: date,
      channels: [
        {
          id: "general",
          name: "general",
          title: "General",
          type: "group",
          workspaceId: "review-workspace",
          createdAt: date,
        },
        {
          id: "design",
          name: "design",
          title: "Design",
          type: "group",
          workspaceId: "review-workspace",
          createdAt: date,
        },
        {
          id: "long",
          name: "a-very-long-channel-name-to-check-small-screen-truncation",
          title: null,
          type: "group",
          workspaceId: "review-workspace",
          createdAt: date,
        },
      ],
      members: [
        { userId: self.id, role: "owner", user: self },
        { userId: human.id, role: "member", user: human },
        { userId: bot.id, role: "member", user: bot },
      ],
    };
    const threads = [
      {
        id: "task-review",
        title: "Plan the product launch",
        conversationId: "dm-hermes",
        botId: "review-bot",
        status: "open",
        createdAt: date,
        updatedAt: date,
        lastActivityAt: date,
      },
      {
        id: "task-long",
        title:
          "ReviewTheEntireCustomerOnboardingJourneyAndPrepareEveryReleaseChecklistWithoutMissingAnyDetails".repeat(
            2,
          ),
        conversationId: "dm-hermes",
        botId: "review-bot",
        status: "open",
        createdAt: date,
        updatedAt: date,
        lastActivityAt: date,
      },
    ];
    const label = "after";
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    const results = [];
    for (const engineName of ["chromium", "webkit"]) {
      const browser = await { chromium, webkit }[engineName].launch();
      try {
        for (const [
          width,
          height,
        ] of "320x640,390x844,768x1024,1024x768,1280x800,1440x900"
          .split(",")
          .map((x) => x.split("x").map(Number))) {
          const page = await browser.newPage({
            viewport: { width, height },
            hasTouch: width < 800,
          });
          const errors = [],
            unknown = [];
          page.on("pageerror", (e) => errors.push(e.message));
          await page.addInitScript(() => {
            localStorage.setItem(
              "thechat:preferences:review-user:active_workspace_id",
              "review-workspace",
            );
          });
          await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
            ws.onMessage((m) => {
              try {
                const x = JSON.parse(String(m));
                if (x.type === "ping")
                  ws.send(JSON.stringify({ type: "pong" }));
              } catch {}
            });
          });
          await page.route("**/*", async (route) => {
            const req = route.request();
            if (!["fetch", "xhr"].includes(req.resourceType()))
              return route.continue();
            const u = new URL(req.url()),
              p = u.pathname;
            let data;
            if (p === "/auth/me") data = { user: self };
            else if (p === "/auth/personal-access-tokens")
              data = { personalAccessTokens: [] };
            else if (p === "/workspaces/list") data = [workspace];
            else if (p === "/workspaces/review-workspace") data = workspace;
            else if (
              p === "/invites/pending" ||
              p === "/bot-workspace-invites/pending"
            )
              data = [];
            else if (p.startsWith("/activity"))
              data = { items: [], totalUnreadMessages: 0 };
            else if (p.startsWith("/conversations/detail/")) {
              const isBot = p.endsWith("dm-hermes");
              const other = isBot ? bot : human;
              data = {
                id: isBot ? "dm-hermes" : "dm-human",
                type: "direct",
                title: null,
                createdAt: date,
                updatedAt: date,
                participants: [
                  { userId: self.id, user: self },
                  {
                    userId: other.id,
                    user: other,
                    ...(isBot
                      ? {
                          bot: {
                            id: "review-bot",
                            kind: "hermes",
                            name: "Hermes",
                          },
                        }
                      : {}),
                  },
                ],
              };
            } else if (p.startsWith("/conversations/threads/"))
              data = { items: threads, hasMore: false, nextCursor: null };
            else if (p.startsWith("/bot-runtime/conversations/"))
              data = {
                conversationId: "dm-hermes",
                invocations: [],
                events: [],
              };
            else if (p.startsWith("/bots/") && p.endsWith("/slash-commands"))
              data = { commands: [] };
            else if (p.startsWith("/conversations/direct"))
              data = {
                id: req.postData()?.includes("review-bot-user")
                  ? "dm-hermes"
                  : "dm-human",
              };
            else if (p.startsWith("/messages/")) {
              const conversationId = p.split("/").at(-1);
              const isBot = conversationId === "dm-hermes";
              data = [
                {
                  id: "message-one",
                  conversationId,
                  threadId: u.searchParams.get("threadId"),
                  senderId: self.id,
                  sender: self,
                  senderName: self.name,
                  senderType: "human",
                  content: isBot
                    ? "Let’s shape the launch plan. What should we focus on first?"
                    : "The launch checklist is ready for review. Let’s keep the first release focused.",
                  createdAt: date,
                  updatedAt: date,
                  attachments: [],
                  reactions: [],
                },
                {
                  id: "message-two",
                  conversationId,
                  threadId: u.searchParams.get("threadId"),
                  senderId: isBot ? bot.id : human.id,
                  sender: isBot ? bot : human,
                  senderName: isBot ? bot.name : human.name,
                  senderType: isBot ? "bot" : "human",
                  content: isBot
                    ? "Start with the essentials:\n\n- A clear onboarding flow\n- A small set of reliable features\n- A final review on desktop and mobile\n\nWe can turn each one into a focused task."
                    : "Agreed. I’ll review the onboarding flow and share feedback here.",
                  createdAt: "2026-09-09T12:01:00.000Z",
                  updatedAt: date,
                  attachments: [],
                  reactions: [],
                },
              ];
            } else {
              unknown.push(req.method() + " " + p);
              return route.fulfill({
                status: 404,
                json: { error: "Unmocked synthetic fixture request" },
              });
            }
            await route.fulfill({ status: 200, json: data });
          });
          for (const [name, hash] of [
            ["channel", "/channel/general"],
            ["dm", "/dm/dm-hermes?threadId=task-review"],
          ]) {
            await page.goto(`${base}/#${hash}`);
            await page
              .locator(".ProseMirror")
              .waitFor({ timeout: 30000 })
              .catch(async (error) => {
                throw new Error(
                  `${engineName} ${width} ${name}: ${error.message}\n${await page.locator("body").innerText()}\n${JSON.stringify({ errors, unknown })}`,
                );
              });
            await page.evaluate(() => document.fonts.ready);
            await page.waitForTimeout(400);
            const text = await page.locator("body").innerText();
            if (text.includes("Something went wrong")) throw new Error(text);
            if (name === "dm")
              await page
                .getByText("Start with the essentials:", { exact: false })
                .waitFor();
            await page.screenshot({
              path: `${out}/${label}-${engineName}-${name}-${width}.png`,
              fullPage: true,
            });
            const geometry = await page.evaluate(() => ({
              width: innerWidth,
              scrollWidth: document.documentElement.scrollWidth,
              header: document
                .querySelector(".chat-header")
                ?.getBoundingClientRect()
                .toJSON(),
              headerText: document.querySelector(".chat-header")?.textContent,
              buttons: [
                ...document.querySelectorAll(".chat-header button"),
              ].map((b) => ({
                name: b.getAttribute("aria-label"),
                rect: b.getBoundingClientRect().toJSON(),
              })),
            }));
            assert.ok(geometry.scrollWidth <= width, "document overflow");
            assert.deepEqual(errors, []);
            assert.deepEqual(unknown, []);
            if (label === "after") {
              assert.equal(
                await page
                  .getByRole("button", { name: "Go back", exact: true })
                  .count(),
                0,
              );
              assert.ok(geometry.header.height >= (width < 1024 ? 52 : 48));
              for (const b of geometry.buttons) {
                assert.ok(
                  b.rect.x >= 0 &&
                    b.rect.right <= width &&
                    b.rect.y >= geometry.header.y &&
                    b.rect.bottom <= geometry.header.bottom,
                  "button contained " + b.name,
                );
                if (width < 1024)
                  assert.ok(
                    b.rect.width >= 44 && b.rect.height >= 44,
                    "touch target " + b.name,
                  );
              }
              if (name === "dm") {
                assert.match(
                  geometry.headerText,
                  /Hermes.*Plan the product launch/,
                );
                const trigger = page.getByRole("button", {
                  name: "Open tasks and activity",
                  exact: true,
                });
                if (width < 1280) {
                  assert.equal(
                    await trigger.evaluate(
                      (el) => !!el.closest(".chat-header"),
                    ),
                    true,
                  );
                  await trigger.click();
                  await page
                    .getByRole("dialog", {
                      name: "Tasks and activity",
                      exact: true,
                    })
                    .waitFor();
                  await page.keyboard.press("Escape");
                  await page.waitForFunction(
                    () =>
                      document.activeElement?.getAttribute("aria-label") ===
                      "Open tasks and activity",
                  );
                  await trigger.click();
                }
                await page
                  .getByRole("button", {
                    name: /ReviewTheEntireCustomerOnboarding/,
                  })
                  .click();
                await page
                  .locator(".chat-header [title]")
                  .filter({ hasText: "ReviewTheEntireCustomerOnboarding" })
                  .waitFor();
                assert.equal(
                  await page.evaluate(
                    () => document.documentElement.scrollWidth <= innerWidth,
                  ),
                  true,
                );
                if (width < 1280) {
                  await page
                    .getByRole("dialog", {
                      name: "Tasks and activity",
                      exact: true,
                    })
                    .waitFor({ state: "hidden" });
                  await trigger.click();
                }
                await page
                  .getByRole("button", { name: "General Inbox", exact: true })
                  .click();
                await page
                  .locator(".chat-header")
                  .filter({ hasText: "General" })
                  .waitFor();
                if (width < 1280) await trigger.click();
                await page
                  .getByRole("button", { name: "New task", exact: true })
                  .click();
                await page
                  .locator(".chat-header")
                  .filter({ hasText: "New task" })
                  .waitFor();
                await page.goto(`${base}/#/dm/dm-human`);
                await page
                  .locator(".chat-header")
                  .filter({ hasText: "Jamie Chen" })
                  .waitFor();
                assert.ok(
                  !(await page.locator(".chat-header").innerText()).includes(
                    "Hermes",
                  ),
                );
                await page.goto(`${base}/#/settings`);
                await page
                  .getByRole("heading", { name: "Profile", exact: true })
                  .waitFor();
                if (width < 1024) {
                  const nav = page.getByRole("button", {
                    name: "Open navigation",
                    exact: true,
                  });
                  await nav.click();
                  await page
                    .getByRole("dialog", {
                      name: "Workspace navigation",
                      exact: true,
                    })
                    .waitFor();
                  await page.keyboard.press("Escape");
                  await page.waitForFunction(
                    () =>
                      document.activeElement?.getAttribute("aria-label") ===
                      "Open navigation",
                  );
                } else
                  assert.equal(await page.locator(".chat-header").count(), 0);
              }
            }
            assert.deepEqual(errors, []);
            assert.deepEqual(unknown, []);
            results.push({
              engineName,
              width,
              name,
              geometry,
              errors: [...errors],
              unknown: [...new Set(unknown)],
              text,
            });
          }
          await page.close();
        }
      } finally {
        await browser.close();
      }
    }
    await fs.writeFile(
      `${out}/${label}-probe.json`,
      JSON.stringify(results, null, 2),
    );
    assert.equal(results.length, 24);
  },
);
