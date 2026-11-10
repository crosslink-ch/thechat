import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { call, clearCredentialFields, login, openNavigation, seedWorkspace, webURL } from './fixtures';

test.afterEach(async ({ page }) => clearCredentialFields(page));

// Optional PR evidence: THECHAT_THREAD_SCREENSHOTS=<dir> saves screenshots.
const screenshotDir = process.env.THECHAT_THREAD_SCREENSHOTS;
async function evidence(page: Page, name: string) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: resolve(screenshotDir, `${name}.png`) });
}

async function messageRow(page: Page, text: string) {
  return page.locator('[data-message-id]').filter({ has: page.getByText(text, { exact: true }) }).first();
}

test('reply threads in a DM: side panel, realtime replies, resize, follow and Threads view', async ({ page, request, browser }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'Side-panel layout and pointer resize are desktop behaviour');
  const f = await seedWorkspace(request);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  // A short DM history so the thread has a real conversation around it.
  const root = 'Can you review the launch checklist before Friday?';
  await call(request, 'POST', `/messages/${f.dm.id}`, { content: 'Morning! Quick one for today.' }, f.b.accessToken);
  const rootMessage = await call(request, 'POST', `/messages/${f.dm.id}`, { content: root }, f.b.accessToken);
  await call(request, 'POST', `/messages/${f.dm.id}`, { content: 'Also: lunch at 12:30?' }, f.a.accessToken);

  await login(page, f.alice);
  await openNavigation(page);
  await page.getByText('Bob Web Test', { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dm/${f.dm.id}`));
  const row = await messageRow(page, root);
  await expect(row).toBeVisible();

  // Reply in thread from the message's hover actions.
  await row.hover();
  await row.getByRole('button', { name: 'Reply in thread', exact: true }).click();
  const panel = page.getByTestId('thread-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('thread-root')).toContainText(root);
  const replyBox = panel.getByRole('textbox', { name: 'Reply in thread' });
  await expect(replyBox).toBeFocused();
  await replyBox.fill('Yes, looking at it now. Two items are still open.');
  await replyBox.press('Enter');
  await expect(panel.getByTestId('thread-replies')).toContainText('Two items are still open.');
  // The reply stays out of the DM timeline (only the panel shows it); the
  // root shows its reply summary.
  await expect(row.locator('[data-thread-summary]')).toContainText('1 reply');
  await expect(page.locator('[data-message-id]').filter({ hasText: 'Two items are still open.' })).toHaveCount(1);
  await expect(panel.locator('[data-message-id]').filter({ hasText: 'Two items are still open.' })).toHaveCount(1);

  // The other person sees the reply count live and answers in the thread.
  const peerContext = await browser.newContext({ baseURL: webURL, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  try {
    const peer = await peerContext.newPage();
    await login(peer, f.bob);
    await openNavigation(peer);
    await peer.getByText('Alice Web Test', { exact: true }).click();
    const peerRow = await messageRow(peer, root);
    await expect(peerRow.locator('[data-thread-summary]')).toContainText('1 reply');
    await peerRow.locator('[data-thread-summary]').click();
    const peerPanel = peer.getByTestId('thread-panel');
    await expect(peerPanel.getByTestId('thread-replies')).toContainText('Two items are still open.');
    const peerBox = peerPanel.getByRole('textbox', { name: 'Reply in thread' });
    await peerBox.fill('Great, which two? I can take the analytics one.');
    await peerBox.press('Enter');
    // Realtime: Alice's open panel receives Bob's reply.
    await expect(panel.getByTestId('thread-replies')).toContainText('I can take the analytics one.');
    await expect(row.locator('[data-thread-summary]')).toContainText('2 replies');

    // "Also send to conversation" mirrors a reply into the DM timeline.
    await replyBox.fill('Analytics + the press kit. Thanks!');
    await panel.getByTestId('thread-also-send').check();
    await replyBox.press('Enter');
    await expect(page.getByText('replied to a thread').first()).toBeVisible();
    await expect(peer.getByText('replied to a thread').first()).toBeVisible();
    await expect(panel.getByTestId('thread-also-send')).not.toBeChecked();
    await evidence(page, '01-dm-thread-panel');

    // Resize: drag the left edge; the width persists across reloads.
    const before = (await panel.boundingBox())!.width;
    const handle = panel.getByTestId('thread-panel-resize');
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x - 180, box.y + 200, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBeGreaterThan(Math.round(before) + 120);
    const widened = Math.round((await panel.boundingBox())!.width);
    // Keyboard resizing for the separator.
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBeLessThan(widened);
    await evidence(page, '02-dm-thread-panel-resized');
    const persisted = Math.round((await panel.boundingBox())!.width);
    await page.goto(`/#/dm/${f.dm.id}?replyThread=${rootMessage.id}`);
    await expect(page.getByTestId('thread-panel')).toBeVisible();
    await expect.poll(async () => Math.round((await page.getByTestId('thread-panel').boundingBox())!.width)).toBe(persisted);

    // Escape closes the panel.
    await page.getByTestId('thread-panel').getByRole('button', { name: 'Close thread', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('thread-panel')).toHaveCount(0);

    // Unread thread replies: Bob replies while Alice is elsewhere.
    await page.goto('/#/activity');
    await peerBox.fill('Press kit draft is in the shared folder.');
    await peerBox.press('Enter');
    const activityThread = page.getByTestId(`activity-thread-${rootMessage.id}`);
    await expect(activityThread).toContainText('Press kit draft is in the shared folder.');
    await expect(activityThread).toContainText('1 new reply');
    await expect(page.getByTestId('sidebar-threads-unread')).toHaveText('1');
    await evidence(page, '03-activity-threads');

    // Threads view lists followed threads with the newest replies.
    await page.getByTestId('sidebar-threads').click();
    await expect(page).toHaveURL(/#\/threads/);
    const followed = page.getByTestId(`followed-thread-${rootMessage.id}`);
    await expect(followed).toContainText(root);
    await expect(followed).toContainText('Press kit draft is in the shared folder.');
    await expect(followed).toContainText('1 new');
    await evidence(page, '04-threads-view');

    // Opening it lands in the DM with the thread open and reads it.
    await followed.getByRole('button').first().click();
    await expect(page).toHaveURL(new RegExp(`/dm/${f.dm.id}`));
    await expect(page.getByTestId('thread-panel')).toContainText('Press kit draft is in the shared folder.');
    await expect(page.getByTestId('sidebar-threads-unread')).toHaveCount(0);

    // Unfollow: later replies no longer create thread activity.
    await page.getByTestId('thread-follow-toggle').click();
    await expect(page.getByTestId('thread-follow-toggle')).toHaveText(/Follow/);
    await page.goto('/#/activity');
    await peerBox.fill('One more thing.');
    await peerBox.press('Enter');
    await expect.poll(async () => {
      const snapshot = await call(request, 'GET', '/activity', undefined, f.a.accessToken);
      return snapshot.threads?.length ?? 0;
    }).toBe(0);
  } finally {
    await peerContext.close();
  }
  expect(errors).toEqual([]);
});

test('reply threads in a channel: deep link, search opens the thread, phone layout', async ({ page, request }, info) => {
  const f = await seedWorkspace(request);
  const root = `Release notes for v2.4 ${info.project.name}`;
  const rootMessage = await call(request, 'POST', `/messages/${f.channel.id}`, { content: root }, f.b.accessToken);
  await call(request, 'POST', `/messages/${f.channel.id}`, { content: 'I added the migration section.', parentMessageId: rootMessage.id }, f.b.accessToken);
  const reply = await call(request, 'POST', `/messages/${f.channel.id}`, {
    content: `Changelog link checked ${info.project.name}`,
    parentMessageId: rootMessage.id,
  }, f.a.accessToken);
  await call(request, 'POST', `/messages/${f.channel.id}`, { content: 'Standup moved to 10:15 today.' }, f.b.accessToken);

  await login(page, f.alice);
  await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
  const row = await messageRow(page, root);
  await expect(row.locator('[data-thread-summary]')).toContainText('2 replies');
  // Replies are not in the channel timeline.
  await expect(page.getByText('I added the migration section.', { exact: true })).toHaveCount(0);

  // A shared link opens the thread and highlights the reply.
  await page.goto(`/#/channel/${f.channel.id}?replyThread=${rootMessage.id}&replyMessage=${reply.id}`);
  const panel = page.getByTestId('thread-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('I added the migration section.');
  await expect(panel.locator('header')).toContainText('general');
  if (info.project.name === 'chromium-desktop') await evidence(page, '05-channel-thread-panel');
  if (info.project.name !== 'chromium-desktop') {
    // Phones: the thread covers the conversation instead of squeezing it.
    const geometry = await panel.boundingBox();
    expect(geometry!.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 2);
    await evidence(page, `06-channel-thread-${info.project.name}`);
  }
  await panel.getByRole('button', { name: 'Close thread', exact: true }).click();
  await expect(panel).toHaveCount(0);

  // Search finds the reply and opens it in its thread.
  await page.goto(`/#/search?q=${encodeURIComponent(`Changelog link checked ${info.project.name}`)}`);
  await page.getByText(`Changelog link checked ${info.project.name}`, { exact: true }).first().click();
  await expect(page.getByTestId('message-context')).toContainText('Thread');
  await page.getByRole('button', { name: /Open thread/ }).click();
  await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
  await expect(page.getByTestId('thread-panel')).toContainText(`Changelog link checked ${info.project.name}`);
});
