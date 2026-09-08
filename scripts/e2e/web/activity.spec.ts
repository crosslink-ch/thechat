import { test, expect } from '@playwright/test';
import { call, login, seedWorkspace } from './fixtures';

// Rebase seam: main's durable Activity must work without a JS bearer credential.
test('cookie Activity opens its workspace and persists rendered-message reads', async ({ page, request }) => {
  const seeded = await seedWorkspace(request);
  const text = 'Unread Activity from a browser-session peer';
  await call(request, 'POST', `/messages/${seeded.channel.id}`, { content: text }, seeded.b.accessToken);
  await login(page, seeded.alice);
  await page.goto('/#/activity');
  const item = page.getByTestId(`activity-item-${seeded.channel.id}`);
  await expect(item).toContainText(text);
  const readResponse = page.waitForResponse(response =>
    response.url().endsWith(`/activity/conversations/${seeded.channel.id}/read`) && response.request().method() === 'POST');
  await item.getByRole('button', { name: /^Open / }).click();
  await expect(page).toHaveURL(new RegExp(`/channel/${seeded.channel.id}`));
  const read = await readResponse;
  expect(read.status()).toBe(200);
  expect(read.request().headers()['authorization']).toBeUndefined();
  expect(read.request().headers()['x-thechat-client']).toBe('web');
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await page.goto('/#/activity');
  await expect(item).toHaveCount(0);

  await call(request, 'POST', `/messages/${seeded.channel.id}`, { content: 'Mark all browser Activity' }, seeded.b.accessToken);
  // Reopening also proves unread persistence independently of worker delivery.
  await page.reload();
  await expect(item).toBeVisible();
  const clearResponse = page.waitForResponse(response => response.url().endsWith('/activity/read-all') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Mark all as read', exact: true }).click();
  expect((await clearResponse).status()).toBe(200);
  await expect(item).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("You're all caught up", { exact: true })).toBeVisible();
});
