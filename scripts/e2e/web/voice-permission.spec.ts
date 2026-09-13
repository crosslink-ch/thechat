import { test, expect } from '@playwright/test';
import { login, seedWorkspace, clearCredentialFields, assertContained } from './fixtures';

// Real Chromium permission decisions with a synthetic microphone device, without
// the fake permission-UI bypass. This is not Windows WebView2/OS consent evidence.
// Headed Chromium is intentional: recent headless builds reject microphone
// capture without their fake-UI flag even after a real permission grant. Use
// xvfb-run -a on display-less Linux rather than bypassing permission decisions.
test.use({ headless: false, launchOptions: { args: ['--use-fake-device-for-media-stream'] } });
test.skip(({ browserName }) => browserName !== 'chromium', 'Uses Chromium permission control');
test.afterEach(async ({ page }) => clearCredentialFields(page));

test('microphone denial stays local and recovers after permission is granted', async ({ page, request }, info) => {
  const f = await seedWorkspace(request);
  let reservations = 0;
  page.on('request', req => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/attachments') reservations++;
  });
  await login(page, f.alice);
  const cdp = await page.context().newCDPSession(page);
  const { targetInfo } = await cdp.send('Target.getTargetInfo');
  await cdp.send('Browser.setPermission', {
    permission: { name: 'microphone' }, setting: 'denied',
    origin: new URL(page.url()).origin, browserContextId: targetInfo.browserContextId,
  });
  await page.getByRole('button', { name: 'Record voice message', exact: true }).click();
  const error = page.getByRole('alert');
  await expect(error).toContainText(/microphone/i);
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toHaveCount(0);
  expect(reservations).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await assertContained(page, '[aria-label="Voice recording"]');
  await page.screenshot({ path: info.outputPath('microphone-denied-390.png'), fullPage: true });

  await cdp.send('Browser.setPermission', {
    permission: { name: 'microphone' }, setting: 'granted',
    origin: new URL(page.url()).origin, browserContextId: targetInfo.browserContextId,
  });
  expect(await page.evaluate(async () => (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state)).toBe('granted');
  await page.getByRole('button', { name: 'Record voice message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel recording', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Record voice message', exact: true })).toBeVisible();
  expect(reservations).toBe(0);
  await cdp.detach();
});
