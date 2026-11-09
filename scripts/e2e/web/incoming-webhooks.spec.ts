import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  apiURL,
  seedWorkspace,
  login,
  openNavigation,
  assertContained,
  clearCredentialFields,
} from "./fixtures";

test.afterEach(async ({ page }) => clearCredentialFields(page));

test("create a secret webhook, receive curl live, hide its URL, and revoke it", async ({
  page,
  request,
}, info) => {
  const fixture = await seedWorkspace(request);
  const errors: string[] = [];
  const frames: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => frames.push(String(frame.payload))),
  );
  await login(page, fixture.alice);
  await expect(page).toHaveURL(new RegExp(`/channel/${fixture.channel.id}`));
  await openNavigation(page);
  const manage = page.getByRole("button", {
    name: "Manage #general",
    exact: true,
  });
  await manage.click();
  await page
    .getByRole("menuitem", { name: "Incoming webhooks", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Webhook name", { exact: true }).fill("Uptime Kuma");
  await page
    .getByRole("button", { name: "Create webhook", exact: true })
    .click();
  const field = page.getByLabel("New webhook URL", { exact: true });
  await expect(field).toHaveValue(/\/hooks\/incoming\/tchat_wh_[0-9a-f]{64}$/);
  const url = await field.inputValue();
  expect(new URL(url).origin).toBe(apiURL);
  await assertContained(page, "[role=dialog]:not([aria-hidden=true])");
  await page.getByRole("button", { name: "Hide URL", exact: true }).click();
  await expect(field).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("incoming-webhooks-settings.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close incoming webhooks" }).click();
  // Dismiss mobile navigation after closing its portaled settings dialog.
  const closeNav = page.getByRole("button", {
    name: "Close navigation",
    exact: true,
  });
  if (await closeNav.isVisible()) await closeNav.click();
  const message =
    "Checkout monitor DOWN: HTTP 503. Synthetic acceptance alert.";
  expect(
    execFileSync(
      "curl",
      [
        "--fail-with-body",
        "--silent",
        "--show-error",
        "--request",
        "POST",
        url,
        "--header",
        "Content-Type: application/json",
        "--data-binary",
        JSON.stringify({ text: message }),
      ],
      { encoding: "utf8" },
    ),
  ).toBe("ok");
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  expect(
    frames.some(
      (frame) => frame.includes("new_message") && frame.includes(message),
    ),
  ).toBe(true);
  await expect(
    page
      .locator("[data-message-header=true]")
      .getByText("Uptime Kuma", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("incoming-webhook-alert.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await openNavigation(page);
  await manage.click();
  await page
    .getByRole("menuitem", { name: "Incoming webhooks", exact: true })
    .click();
  await expect(page.getByText("Uptime Kuma", { exact: true })).toBeVisible();
  await expect(field).toHaveCount(0);
  await page
    .getByRole("button", { name: "Revoke Uptime Kuma", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm revoke", exact: true })
    .click();
  await expect(page.getByText("No incoming webhooks yet.")).toBeVisible();
  expect(
    (await request.post(url, { data: { text: "Should not appear" } })).status(),
  ).toBe(404);
  expect(errors).toEqual([]);
});
