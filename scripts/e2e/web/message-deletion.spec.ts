import { test, expect } from '@playwright/test';
import { apiURL, webURL, seedWorkspace, login, call, openNavigation, assertContained, clearCredentialFields } from './fixtures';

test('authors delete for everyone live, with confirmation, in channels and DMs', async ({ page, request, browser }, info) => {
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
    let peerNavigations = 0;
    peer.on('framenavigated', frame => { if (frame === peer.mainFrame()) peerNavigations++; });
    for (const scope of ['channel', 'dm'] as const) {
      const id = scope === 'channel' ? f.channel.id : f.dm.id;
      if (scope === 'dm') {
        await openNavigation(page);
        await page.getByText('Bob Web Test', { exact: true }).click();
        await openNavigation(peer);
        await peer.getByText('Alice Web Test', { exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/dm/${id}`));
        await expect(peer).toHaveURL(new RegExp(`/dm/${id}`));
      }
      const content = scope === 'channel' ? 'I sent this to the wrong conversation.' : 'This private message was sent by mistake.';
      await page.locator('[contenteditable=true]').first().fill(content);
      await page.getByTitle('Send message', { exact: true }).click();
      await expect(peer.getByText(content, { exact: true })).toBeVisible();
      const messages = await call(request, 'GET', `/messages/${id}`, undefined, f.a.accessToken);
      const sent = messages.find((m: any) => m.content === content);
      expect(sent).toBeTruthy();
      const row = page.locator(`[data-message-id="${sent.id}"]`);
      const peerRow = peer.locator(`[data-message-id="${sent.id}"]`);
      await row.hover();
      await expect(row.getByRole('button', { name: 'Delete message', exact: true })).toBeVisible();
      await expect(peerRow.getByRole('button', { name: 'Delete message', exact: true })).toHaveCount(0);
      const forbidden = await request.delete(`${apiURL}/messages/${id}/${sent.id}`, { headers: { authorization: `Bearer ${f.b.accessToken}` } });
      expect(forbidden.status()).toBe(403);
      if (scope === 'channel') await page.screenshot({ path: info.outputPath('delete-toolbar.png') });
      await row.getByRole('button', { name: 'Delete message', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Delete message?' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(row).toBeVisible();
      await row.hover();
      await row.getByRole('button', { name: 'Delete message', exact: true }).click();
      await assertContained(page, '[role=dialog]');
      if (scope === 'channel') await page.screenshot({ path: info.outputPath('delete-confirmation.png') });
      const navigationsBefore = peerNavigations;
      await dialog.getByRole('button', { name: 'Delete for everyone', exact: true }).click();
      await expect(row).toHaveCount(0);
      await expect(peerRow).toHaveCount(0);
      expect(peerNavigations).toBe(navigationsBefore);
      expect((await call(request, 'GET', `/messages/${id}`, undefined, f.b.accessToken)).some((m: any) => m.id === sent.id)).toBe(false);
      await peer.reload();
      await expect(peer.locator('[contenteditable=true]')).toBeVisible();
      await expect(peerRow).toHaveCount(0);
    }
    expect(errors).toEqual([]);
    await clearCredentialFields(peer);
  } finally {
    await clearCredentialFields(page);
    await peerContext.close();
  }
});
