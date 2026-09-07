import { test, expect } from '@playwright/test';
import { apiURL, webURL, webHeaders, seedWorkspace, login, clearCredentialFields } from './fixtures';
test.afterEach(async ({ page }) => clearCredentialFields(page));

test('revalidation outage preserves drafts; real server revocation clears them', async ({ page, request }) => {
  const f = await seedWorkspace(request);
  await login(page, f.alice);
  await page.goto(`${webURL}/#/dm/${f.dm.id}`);
  const editor = page.getByRole('textbox', { name: 'Message', exact: true });
  await editor.fill('A draft that must survive a temporary outage');
  let failures = 0;
  // Explicit fault injection on this page only. No fake successful API result.
  await page.route(`${apiURL}/auth/me`, async route => {
    failures += 1;
    await route.fulfill({ status: 503, contentType: 'application/json',
      headers: { 'access-control-allow-origin': new URL(webURL).origin, 'access-control-allow-credentials': 'true' },
      body: '{"error":"Injected authentication service outage"}',
    });
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => failures).toBeGreaterThan(0);
  await expect(editor).toHaveText('A draft that must survive a temporary outage');
  await expect(page.locator('#auth-email')).toHaveCount(0);
  await page.unroute(`${apiURL}/auth/me`);

  // Revoke through the real API without sending a frontend logout signal.
  const revoked = await page.context().request.post(`${apiURL}/auth/logout`, { headers: webHeaders, data: {} });
  expect(revoked.ok()).toBe(true);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#auth-email')).toBeVisible();
  await login(page, f.alice);
  await page.goto(`${webURL}/#/dm/${f.dm.id}`);
  await expect(editor).toHaveText('');
});
