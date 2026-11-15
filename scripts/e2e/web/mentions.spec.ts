import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { call, clearCredentialFields, login, openNavigation, seedWorkspace, webURL } from './fixtures';

/**
 * Mentions by user ID, with two signed-in browsers.
 *
 * Alice picks Bob from the @ menu: Bob sees the "mentions you" highlight and
 * gets a notification. Alice types "@Bob Web Test" by hand: it stays text, Bob
 * gets neither. Notifications are observed where the app hands them to the
 * browser (Notification / ServiceWorkerRegistration.showNotification), since
 * an OS notification cannot be read from a page.
 */

test.afterEach(async ({ page }) => clearCredentialFields(page));

// Optional PR evidence: THECHAT_MENTION_SCREENSHOTS=<dir> saves screenshots.
const screenshotDir = process.env.THECHAT_MENTION_SCREENSHOTS;
async function evidence(page: Page, name: string) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: resolve(screenshotDir, `${name}.png`) });
}

/**
 * Stand in for the browser's notification API: report permission as granted
 * and record what the app shows. Headless Chromium reports "denied" even
 * after grantPermissions, and cannot display an OS notification anyway.
 */
async function recordNotifications(page: Page) {
  await page.addInitScript(() => {
    const shown: { title: string; body: string }[] = [];
    (window as unknown as { __shownNotifications: typeof shown }).__shownNotifications = shown;
    class RecordingNotification {
      static permission: NotificationPermission = 'granted';
      static requestPermission = async () => 'granted' as NotificationPermission;
      constructor(title: string, options?: NotificationOptions) {
        shown.push({ title, body: options?.body ?? '' });
      }
      close() {}
    }
    window.Notification = RecordingNotification as unknown as typeof Notification;
    ServiceWorkerRegistration.prototype.showNotification = async function (title: string, options?: NotificationOptions) {
      shown.push({ title, body: options?.body ?? '' });
    };
  });
}

const shownNotifications = (page: Page) =>
  page.evaluate(() => (window as unknown as { __shownNotifications: { title: string; body: string }[] }).__shownNotifications);

async function messageRow(page: Page, text: string) {
  return page.locator('[data-message-id]').filter({ hasText: text }).last();
}

test('a mention picked from the @ menu highlights and notifies; a typed @Name does neither', async ({ page, request, browser }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'Two-session notification flow runs once, on desktop Chromium');
  const f = await seedWorkspace(request);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  // Bob waits in the DM, so a channel message is "elsewhere" and may notify.
  const bobContext = await browser.newContext({ baseURL: webURL, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  try {
    const bob = await bobContext.newPage();
    await recordNotifications(bob);
    await login(bob, f.bob);
    await openNavigation(bob);
    await bob.getByText('Alice Web Test', { exact: true }).click();
    await expect(bob).toHaveURL(new RegExp(`/dm/${f.dm.id}`));

    await login(page, f.alice);
    await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
    const editor = page.locator('[contenteditable=true]').first();

    // 1. Picked from the menu: People and Agents sections, then Bob by ID.
    await editor.click();
    await editor.pressSequentially('Can you review this, @Bob');
    const menu = page.getByTestId('mention-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('group', { name: 'People' })).toBeVisible();
    await evidence(page, '01-mention-picker');
    await menu.getByRole('option', { name: /Bob Web Test/ }).click();
    await expect(editor.locator('[data-type="mention"]')).toHaveAttribute('data-id', f.b.user.id);
    // Picking inserts the mention and a space, as in Slack.
    await editor.pressSequentially('before Friday?');
    await page.getByTitle('Send message', { exact: true }).click();

    const picked = await messageRow(page, 'before Friday?');
    await expect(picked.locator('.md-mention')).toHaveText('@Bob Web Test');
    await expect(picked.locator('.md-mention')).toHaveAttribute('data-mention-id', f.b.user.id);

    // The server stored the reference by ID.
    await expect.poll(async () => {
      const messages = await call(request, 'GET', `/messages/${f.channel.id}`, undefined, f.a.accessToken);
      const sent = messages.find((m: any) => m.content === 'Can you review this, @Bob Web Test before Friday?');
      return sent?.parts?.find((part: any) => part.type === 'reference')?.refId ?? null;
    }).toBe(f.b.user.id);

    // Bob is notified once, and sees the highlight when he opens the channel.
    await expect.poll(async () => (await shownNotifications(bob)).map(n => n.title)).toEqual(['Alice Web Test mentioned you']);
    await bob.goto(`/#/channel/${f.channel.id}`);
    const bobPicked = await messageRow(bob, 'before Friday?');
    await expect(bobPicked).toHaveAttribute('data-mentions-you', 'true');
    await expect(bobPicked.locator('.md-mention-self')).toHaveText('@Bob Web Test');
    await evidence(bob, '02-mentions-you-highlight');

    // 2. Typed by hand: plain text, no highlight, no notification.
    await bob.goto(`/#/dm/${f.dm.id}`);
    await expect(bob).toHaveURL(new RegExp(`/dm/${f.dm.id}`));
    await editor.click();
    await editor.pressSequentially('Typed by hand: @Bob Web Test');
    // Close the menu without picking, then send what was typed.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('mention-menu')).toHaveCount(0);
    await page.getByTitle('Send message', { exact: true }).click();
    const typed = await messageRow(page, 'Typed by hand:');
    await expect(typed).toBeVisible();
    await expect(typed.locator('.md-mention')).toHaveCount(0);

    await expect.poll(async () => {
      const messages = await call(request, 'GET', `/messages/${f.channel.id}`, undefined, f.a.accessToken);
      const sent = messages.find((m: any) => m.content === 'Typed by hand: @Bob Web Test');
      return sent ? { format: sent.contentFormat, refs: sent.parts.filter((p: any) => p.type === 'reference').length } : null;
    }).toEqual({ format: 'parts-v1', refs: 0 });
    // Give realtime the same chance it had for the picked mention.
    await bob.waitForTimeout(1_500);
    expect((await shownNotifications(bob)).map(n => n.title)).toEqual(['Alice Web Test mentioned you']);

    await bob.goto(`/#/channel/${f.channel.id}`);
    const bobTyped = await messageRow(bob, 'Typed by hand:');
    await expect(bobTyped).toBeVisible();
    await expect(bobTyped).not.toHaveAttribute('data-mentions-you', 'true');
    await evidence(page, '03-mention-pill-and-typed-text');
    expect(errors).toEqual([]);
  } finally {
    await bobContext.close();
  }
});

test('the @ menu fits a phone screen', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'chromium-phone', 'Phone layout check');
  const f = await seedWorkspace(request);
  await login(page, f.alice);
  await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
  const editor = page.locator('[contenteditable=true]').first();
  await editor.click();
  await editor.pressSequentially('@');
  const menu = page.getByTestId('mention-menu');
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  await evidence(page, '04-mention-picker-phone');
});
