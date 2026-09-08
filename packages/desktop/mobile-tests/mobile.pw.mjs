import { test, expect } from "./support.mjs";

// Synthetic stores/callbacks around production components. NOT auth/API/LLM E2E.
async function load(page) {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  return errors;
}
async function within(locator, width, height) {
  const r = await locator.boundingBox();
  expect(r).not.toBeNull();
  expect(r.width).toBeGreaterThan(0);
  expect(r.x).toBeGreaterThanOrEqual(-1);
  expect(r.y).toBeGreaterThanOrEqual(-1);
  expect(r.x + r.width).toBeLessThanOrEqual(width + 1);
  expect(r.y + r.height).toBeLessThanOrEqual(height + 1);
  return r;
}
async function touch(locator) {
  const r = await locator.boundingBox();
  expect(r.width).toBeGreaterThanOrEqual(44);
  expect(r.height).toBeGreaterThanOrEqual(44);
}
async function screenshot(page, info, name) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

for (const [width, height] of [[320, 640], [390, 844], [768, 1024], [320, 300], [390, 320]]) {
  test(`fixture geometry and editable composer ${width}x${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    const errors = await load(page);
    // Prove Tailwind was emitted by the isolated harness, not just JSX.
    await expect(page.locator(".fixture-frame")).toHaveCSS("display", "flex");
    await expect(page.locator(".fixture-frame")).toHaveCSS("flex-direction", "column");
    const editor = page.getByRole("textbox", { name: "Message", exact: true });
    await editor.fill("A phone draft with a long line ".repeat(12));
    await within(editor, width, height);
    const send = page.getByRole("button", { name: "Send message", exact: true });
    await within(send, width, height);
    await touch(send);
    await within(page.getByRole("button", { name: "Attach image", exact: true }), width, height);
    await touch(page.getByRole("button", { name: "Attach image", exact: true }));
    await within(page.getByRole("button", { name: "Open navigation" }), width, height);
    await within(page.getByRole("button", { name: "Open tasks and activity" }), width, height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator(".fixture-messages").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await screenshot(page, info, `${width}x${height}`);
    await send.tap();
    await expect(page.getByTestId("sent")).toHaveText("A phone draft with a long line ".repeat(12).trim());
    await expect(editor).toHaveText("");
    expect(errors).toEqual([]);
  });
}

test.describe("desktop baseline", () => {
  test.use({ hasTouch: false, viewport: { width: 1440, height: 900 } });
  test("retains the 347px sidebar and persistent task rail at 1440", async ({ page }, info) => {
    const errors = await load(page);
    await expect(page.getByRole("button", { name: "Open navigation" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open tasks and activity" })).toHaveCount(0);
    const sidebar = await within(page.locator(".app-sidebar"), 1440, 900);
    expect(sidebar.width).toBe(347);
    await within(page.getByRole("complementary", { name: "Hermes tasks and activity" }), 1440, 900);
    await within(page.getByRole("textbox", { name: "Message", exact: true }), 1440, 900);
    await within(page.getByRole("button", { name: "Send message", exact: true }), 1440, 900);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(page, info, "1440x900-desktop");
    expect(errors).toEqual([]);
  });
});

test("navigation traps/restores focus; same/new route, outside, Escape and Back dismiss", async ({ page }, info) => {
  const errors = await load(page);
  const trigger = page.getByRole("button", { name: "Open navigation" });
  const dialog = page.getByRole("dialog", { name: "Workspace navigation" });
  await trigger.tap();
  await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
  await within(dialog, 320, 640);
  await touch(page.locator('[data-channel-id="general"]'));
  await expect(page.getByRole("button", { name: "Manage #general" })).toHaveCSS("opacity", "1");
  await touch(page.getByRole("button", { name: "Manage #general" }));
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]'))).toBe(true);
  await page.getByRole("button", { name: "M Mobile tester", exact: true }).tap();
  await expect(page.getByRole("button", { name: "Log out", exact: true })).toBeVisible();
  await screenshot(page, info, "320-navigation-profile");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.tap();
  await page.locator('[data-channel-id="general"]').tap();
  await expect(dialog).toHaveCount(0);
  await trigger.tap();
  await page.locator('[data-channel-id="long"]').tap();
  await expect(dialog).toHaveCount(0);
  await trigger.tap();
  await page.mouse.click(316, 200);
  await expect(dialog).toHaveCount(0);
  // Fixture uses memory routing; a synthetic same-document history entry proves native popstate dismissal.
  await page.evaluate(() => history.pushState({ fixture: true }, ""));
  await trigger.tap();
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("tasks, General and New task are navigable by touch", async ({ page }, info) => {
  const errors = await load(page);
  const trigger = page.getByRole("button", { name: "Open tasks and activity" });
  await trigger.tap();
  await within(page.getByRole("dialog", { name: "Tasks and activity" }), 320, 640);
  await screenshot(page, info, "320-tasks");
  await page.getByRole("button", { name: /Plan the mobile rollout/ }).tap();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("thread-selection")).toHaveText("task-one");
  await expect(trigger).toBeFocused();
  await trigger.tap();
  await page.getByRole("button", { name: "New task", exact: true }).tap();
  await expect(page.getByTestId("thread-selection")).toHaveText("New task");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await trigger.tap();
  await page.getByRole("button", { name: "General Inbox", exact: true }).tap();
  await expect(page.getByTestId("thread-selection")).toHaveText("General");
  expect(errors).toEqual([]);
});

test("reaction picker and removal work without hover", async ({ page }, info) => {
  const errors = await load(page);
  const add = page.getByRole("button", { name: "Add reaction" });
  await add.scrollIntoViewIfNeeded();
  await expect(add).toHaveCSS("opacity", "1");
  await touch(add);
  await add.tap();
  await touch(page.getByRole("menuitem", { name: "React with 👍" }));
  await screenshot(page, info, "320-reactions");
  await page.getByRole("menuitem", { name: "React with 👍" }).tap();
  const reaction = page.getByRole("button", { name: "👍 1 reaction" });
  await expect(reaction).toHaveAttribute("aria-pressed", "true");
  await reaction.tap();
  await expect(reaction).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("workspace dialog remains editable and dismissible at short height", async ({ page }, info) => {
  const errors = await load(page);
  await page.getByRole("button", { name: "Open navigation" }).tap();
  await page.getByRole("button", { name: "Create workspace", exact: true }).tap();
  await page.setViewportSize({ width: 320, height: 280 });
  await expect(page.locator(".app-viewport")).toHaveCSS("height", "280px");
  const dialog = page.getByRole("dialog", { name: "Create workspace" });
  await within(dialog, 320, 280);
  const input = page.getByRole("textbox", { name: "Workspace name" });
  await input.fill("Mobile workspace with a long name");
  await within(input, 320, 280);
  await touch(input);
  await screenshot(page, info, "320x280-workspace-dialog");
  await page.getByRole("button", { name: "Close workspace dialog" }).tap();
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("synthetic approval and custom clarification remain touch-operable", async ({ page }, info) => {
  const errors = await load(page);
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await approve.scrollIntoViewIfNeeded();
  await touch(approve);
  await approve.tap();
  await expect(page.getByTestId("interaction")).toHaveText("approval:once");
  const choice = page.getByRole("button", { name: "Careful verification of all important user journeys" });
  await choice.scrollIntoViewIfNeeded();
  await touch(choice);
  await within(choice, 320, 640);
  await page.getByRole("button", { name: "Other", exact: true }).tap();
  const field = page.getByRole("textbox", { name: "Other response" });
  await field.fill("Verified from a phone");
  await touch(field);
  await within(field, 320, 640);
  const submit = page.getByRole("button", { name: "Submit", exact: true });
  await touch(submit);
  await screenshot(page, info, "320-clarification");
  await submit.tap();
  await expect(page.getByTestId("interaction")).toHaveText("clarify:Verified from a phone");
  expect(errors).toEqual([]);
});

test("local attachment tray scrolls without hiding send at 320x300", async ({ page }, info) => {
  const errors = await load(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach image", exact: true }).tap();
  await (await chooser).setFiles(Array.from({ length: 6 }, (_, i) => ({ name: `fixture-${i}.png`, mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") })));
  const remove = page.getByRole("button", { name: "Remove image", exact: true });
  await expect(remove).toHaveCount(6);
  await page.setViewportSize({ width: 320, height: 300 });
  await expect(page.locator(".app-viewport")).toHaveCSS("height", "300px");
  const send = page.getByRole("button", { name: "Send message", exact: true });
  await within(send, 320, 300);
  await expect(remove.first()).toHaveCSS("opacity", "1");
  await touch(remove.first());
  await remove.last().scrollIntoViewIfNeeded();
  await remove.last().tap();
  await expect(remove).toHaveCount(5);
  await screenshot(page, info, "320x300-attachments");
  await within(send, 320, 300);
  expect(errors).toEqual([]);
});
