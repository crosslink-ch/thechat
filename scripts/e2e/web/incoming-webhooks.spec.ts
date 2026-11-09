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

// Capture credential-bearing journeys only after redaction, never automatically.
test.use({ screenshot: "off", trace: "off" });
test.afterEach(async ({ page }, info) => {
  await clearCredentialFields(page);
  await page.locator('[aria-label="New webhook URL"]').evaluateAll((fields) => {
    for (const field of fields as HTMLInputElement[]) {
      field.value = "";
      field.removeAttribute("value");
    }
  });
  if (info.status !== info.expectedStatus) {
    await page.screenshot({
      path: info.outputPath("failure-redacted.png"),
      fullPage: true,
      mask: [page.locator("input")],
      animations: "disabled",
    });
  }
});

test("create a secret webhook, receive curl live, hide its URL, and revoke it", async ({
  page,
  request,
}, info) => {
  const fixture = await seedWorkspace(request);
  try {
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
    await expect(field).toBeVisible();
    const url = await field.inputValue();
    // Boolean assertions avoid printing the credential in failure reports.
    expect(/\/hooks\/incoming\/tchat_wh_[0-9a-f]{64}$/.test(url)).toBe(true);
    expect(new URL(url).origin).toBe(apiURL);
    await assertContained(page, "[role=dialog]:not([aria-hidden=true])");
    await page.getByRole("button", { name: "Hide URL", exact: true }).click();
    await expect(field).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("incoming-webhooks-settings.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Close incoming webhooks" }).click();
    const closeNav = page.getByRole("button", {
      name: "Close navigation",
      exact: true,
    });
    if (await closeNav.isVisible()) await closeNav.click();
    const message =
      "Checkout monitor DOWN: HTTP 503. Synthetic acceptance alert.";
    let response: string;
    try {
      response = execFileSync(
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
      );
    } catch {
      // Node's default child-process error includes the complete command/URL.
      throw new Error("curl webhook post failed (URL redacted)");
    }
    expect(response).toBe("ok");
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
      (
        await request.post(url, { data: { text: "Should not appear" } })
      ).status(),
    ).toBe(404);
    expect(errors).toEqual([]);
  } finally {
    // This workspace is unique to the test. Server-side listing also covers a
    // successful create whose browser response/assertions were interrupted.
    const endpoint = `${apiURL}/channels/${fixture.channel.id}/incoming-webhooks`;
    const headers = { authorization: `Bearer ${fixture.a.accessToken}` };
    const listed = await request.get(endpoint, { headers });
    expect(listed.ok(), "Cleanup must be able to list test webhooks").toBe(
      true,
    );
    for (const hook of (await listed.json()).webhooks) {
      const revoked = await request.delete(`${endpoint}/${hook.id}`, {
        headers,
      });
      expect(
        [200, 404].includes(revoked.status()),
        "Cleanup must revoke test webhooks",
      ).toBe(true);
    }
    const remaining = await request.get(endpoint, { headers });
    expect(remaining.ok()).toBe(true);
    expect((await remaining.json()).webhooks).toHaveLength(0);
  }
});
