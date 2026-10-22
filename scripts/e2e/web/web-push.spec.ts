import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { call, clearCredentialFields, login, seedWorkspace, webURL } from './fixtures';

/**
 * Real Web Push through Google's push service (FCM): installed Google Chrome,
 * the production service worker, a real subscription and real delivery to a
 * browser with no TheChat page open.
 *
 * Opt-in: needs headed Google Chrome (run under xvfb-run on Linux), outbound
 * access to Google's push service, and an API + worker started with VAPID keys
 * (WEB_PUSH_*). It still does not prove a locked phone shows the notification.
 */
const enabled = process.env.THECHAT_WEB_E2E_REAL_PUSH === '1';
test.skip(!enabled, 'Set THECHAT_WEB_E2E_REAL_PUSH=1 to run against the real push service');
test.describe.configure({ timeout: 180_000 });

type Shown = { title: string; body: string; tag: string; data: { id?: string; url?: string } | null };

/** Notifications currently shown for TheChat, read without loading the app. */
async function shownNotifications(context: BrowserContext): Promise<Shown[]> {
  const probe = await context.newPage();
  try {
    await probe.goto(`${webURL}/manifest.webmanifest`);
    return await probe.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const list = (await registration?.getNotifications()) ?? [];
      return list.map(n => ({ title: n.title, body: n.body, tag: n.tag, data: n.data }));
    });
  } finally {
    await probe.close();
  }
}

async function waitForNotification(context: BrowserContext, match: (n: Shown) => boolean, label: string) {
  let last: Shown[] = [];
  await expect.poll(async () => {
    last = await shownNotifications(context);
    return last.some(match);
  }, { message: `${label}; shown: ${JSON.stringify(last)}`, timeout: 60_000, intervals: [500, 1000, 2000] }).toBe(true);
  return last.find(match)!;
}

test('a direct message reaches a closed TheChat through the real push service', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'One real-push run is enough');
  const seeded = await seedWorkspace(request);
  const profile = await mkdtemp(join(tmpdir(), 'thechat-push-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: false,
    // Chrome's push connection is background networking; Playwright disables it by default.
    ignoreDefaultArgs: ['--disable-background-networking', '--disable-component-update'],
    viewport: { width: 1280, height: 900 },
  });
  let page: Page | null = null;
  try {
    await context.grantPermissions(['notifications'], { origin: new URL(webURL).origin });
    page = await context.newPage();
    await login(page, seeded.bob);

    // The one-time prompt turns it on from a tap.
    const prompt = page.getByRole('dialog', { name: 'Get notified when TheChat is closed' });
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Turn on' }).click();
    await expect(prompt).toHaveCount(0);

    await page.goto(`${webURL}/#/settings`);
    // A fresh Chrome profile first registers with Google's push service; this
    // took ~30s on a cloud VM. Phones that already use FCM subscribe quickly.
    await expect(page.getByText("On. You'll get notifications when TheChat is closed.")).toBeVisible({ timeout: 90_000 });
    const endpointHost = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      return subscription ? new URL(subscription.endpoint).hostname : null;
    });
    expect(endpointHost).toBe('fcm.googleapis.com');

    // Round trip through FCM while the app is open.
    await page.getByRole('button', { name: 'Send test notification' }).click();
    await expect(page.getByText(/Sent\. It should appear/)).toBeVisible();
    await waitForNotification(context, n => n.body === 'Notifications work on this device.', 'test notification');

    // Close every TheChat page: only the service worker can show the next one.
    await clearCredentialFields(page);
    await page.close();
    page = null;
    const sent = await call(request, 'POST', `/messages/${seeded.dm.id}`, { content: 'Push from a closed tab' }, seeded.a.accessToken);
    const shown = await waitForNotification(context, n => n.data?.id === `message:${sent.id}`, 'direct message push');
    expect(shown).toMatchObject({ title: 'Alice Web Test', body: 'Push from a closed tab', tag: `conversation:${seeded.dm.id}:main` });
    expect(shown.data?.url).toBe(`#/open?conversationId=${seeded.dm.id}&type=direct&workspaceId=${seeded.workspace.id}`);

    // Where a tap lands.
    page = await context.newPage();
    await page.goto(`${webURL}/${shown.data!.url}`);
    await expect(page).toHaveURL(new RegExp(`#/dm/${seeded.dm.id}`));
    await expect(page.getByText('Push from a closed tab').first()).toBeVisible();

    // After logging out the device is gone: nothing more arrives.
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      for (const notification of await registration.getNotifications()) notification.close();
    });
    const logout = await page.evaluate(async api => (await fetch(`${api}/auth/logout`, {
      method: 'POST', credentials: 'include', headers: { 'X-TheChat-Client': 'web', 'Content-Type': 'application/json' }, body: '{}',
    })).status, process.env.THECHAT_WEB_E2E_API_URL || 'http://127.0.0.1:13300');
    expect(logout).toBe(200);
    await page.close();
    page = null;
    const after = await call(request, 'POST', `/messages/${seeded.dm.id}`, { content: 'After logout' }, seeded.a.accessToken);
    await new Promise(resolve => setTimeout(resolve, 15_000));
    expect((await shownNotifications(context)).some(n => n.data?.id === `message:${after.id}`)).toBe(false);
  } finally {
    if (page) await clearCredentialFields(page);
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
