import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { apiURL, webURL, webHeaders, seedWorkspace, login, call, openNavigation, assertContained, identity } from './fixtures';

test('desktop bearer compatibility and isolated membership fixtures', async ({ request }) => {
  const fixture = await seedWorkspace(request);
  expect(typeof fixture.a.accessToken === 'string').toBe(true);
  expect(fixture.channel.name).toBe('general');
  expect(fixture.dm.id).toBeTruthy();
  const outsider = await call(request, 'POST', '/auth/register', identity('Outside user'));
  const response = await request.get(`${apiURL}/messages/${fixture.channel.id}`, { headers: { authorization: `Bearer ${outsider.accessToken}` } });
  expect([403, 404]).toContain(response.status());
});

test('channels, DMs, real-time delivery, attachments and short phone viewport', async ({ page, request, browser }, info) => {
  const f = await seedWorkspace(request);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page, f.alice);
  await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
  const peerContext = await browser.newContext({ baseURL: webURL, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  try {
    const peer = await peerContext.newPage();
    await login(peer, f.bob);
    await expect(peer).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
    const content = `Browser message ${info.project.name}`;
    const editor = page.locator('[contenteditable=true]').first();
    await editor.fill(content);
    await page.getByTitle('Send message', { exact: true }).click();
    await expect(peer.getByText(content, { exact: true })).toBeVisible();
    await expect.poll(async () => (await call(request, 'GET', `/messages/${f.channel.id}`, undefined, f.a.accessToken)).filter((m: any) => m.content === content).length).toBe(1);
    await page.reload();
    await expect(page.getByText(content, { exact: true })).toBeVisible();

    await openNavigation(page);
    await page.getByText('Bob Web Test', { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/dm/${f.dm.id}`));
    await expect(page.locator('[contenteditable=true]')).toBeVisible();
    const dmText = `Private message ${info.project.name}`;
    await page.locator('[contenteditable=true]').fill(dmText);
    await page.getByTitle('Send message', { exact: true }).click();
    await expect.poll(async () => (await call(request, 'GET', `/messages/${f.dm.id}`, undefined, f.b.accessToken)).filter((m: any) => m.content === dmText).length).toBe(1);

    await page.locator('input[type=file]').setInputFiles([
      { name: 'browser-note.txt', mimeType: 'text/plain', buffer: Buffer.from('TheChat browser attachment acceptance\n') },
      { name: 'browser-image.png', mimeType: 'image/png', buffer: await readFile(resolve('packages/desktop/src-tauri/icons/32x32.png')) },
    ]);
    await expect(page.getByTitle('Send message', { exact: true })).toBeEnabled({ timeout: 30_000 });
    await page.getByTitle('Send message', { exact: true }).click();
    await expect.poll(async () => (await call(request, 'GET', `/messages/${f.dm.id}`, undefined, f.a.accessToken)).reduce((n: number, m: any) => n + (m.attachments?.length || 0), 0), { timeout: 30_000 }).toBe(2);
    await expect(page.getByText('browser-note.txt', { exact: true })).toBeVisible();
    const downloadPending = page.waitForEvent('download');
    await page.getByTitle('Download browser-note.txt', { exact: true }).click();
    const download = await downloadPending;
    expect(download.suggestedFilename()).toBe('browser-note.txt');
    const downloadedPath = info.outputPath('browser-note.txt');
    await download.saveAs(downloadedPath);
    expect(await readFile(downloadedPath, 'utf8')).toBe('TheChat browser attachment acceptance\n');
    const image = page.getByAltText('browser-image.png').first();
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

    await page.setViewportSize({ width: 320, height: 480 });
    await page.locator('[contenteditable=true]').fill('Short viewport draft');
    await assertContained(page, '[contenteditable=true]');
    await assertContained(page, '[title="Send message"]');
    await assertContained(page, '[title="Attach files"]');
    const send = await page.getByTitle('Send message', { exact: true }).boundingBox();
    expect(send!.height).toBeGreaterThanOrEqual(44);
    expect(send!.width).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath('phone-320-short-viewport.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await peerContext.close();
  }
});

test('logout propagates across tabs and revokes server access', async ({ page, context, request }) => {
  const f = await seedWorkspace(request);
  await login(page, f.alice);
  await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
  const sibling = await context.newPage();
  await sibling.goto(webURL);
  await expect(sibling).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
  await openNavigation(page);
  await page.getByRole('button', { name: /Alice Web Test/ }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.locator('#auth-email')).toBeVisible();
  await expect(sibling.locator('#auth-email')).toBeVisible();
  const me = await context.request.get(`${apiURL}/auth/me`, { headers: webHeaders });
  expect(me.status()).toBe(401);
  await sibling.reload();
  await expect(sibling.locator('#auth-email')).toBeVisible();
});
