import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { call, clearCredentialFields, login, openNavigation, seedWorkspace } from './fixtures';

test.afterEach(async ({ page }) => clearCredentialFields(page));

/** PR screenshots go here when set; nothing is written otherwise. */
async function shot(page: Page, name: string) {
  const dir = process.env.THECHAT_FRIENDLY_NAMES_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  await page.screenshot({ path: join(dir, name) });
}

/** Create "My Channel" through the sidebar's create dialog, as a person would. */
async function createMyChannel(page: Page) {
  await openNavigation(page);
  await page.getByRole('button', { name: 'Create channel', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Channel name' }).fill('My Channel');
  await expect(dialog.getByTestId('channel-name-preview')).toHaveText(
    'This channel will appear as My Channel with the unique name #my-channel.',
  );
  await dialog.getByRole('button', { name: 'Create channel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/channel\/[0-9a-f-]{36}/);
  return /\/channel\/([0-9a-f-]{36})/.exec(page.url())![1]!;
}

test('a channel created as "My Channel" reads as My Channel everywhere people see it', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'One full journey; phones are covered below');
  const f = await seedWorkspace(request);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bot = await call(request, 'POST', '/bots/create', { name: 'Release Hermes', kind: 'hermes', workspaceId: f.workspace.id }, f.a.accessToken);

  await login(page, f.alice);
  await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
  const channelId = await createMyChannel(page);

  // The slug is still the unique name in the API, for bots and links.
  const detail = await call(request, 'GET', `/workspaces/${f.workspace.id}`, undefined, f.a.accessToken);
  expect(detail.channels.find((channel: any) => channel.id === channelId)).toMatchObject({ name: 'my-channel', title: 'My Channel' });

  // Sidebar and header: the # stays, the title replaces the slug.
  const sidebar = page.locator('.app-sidebar');
  await expect(sidebar.locator(`[data-channel-id="${channelId}"]`)).toHaveText('#My Channel');
  await expect(sidebar.locator(`[data-channel-id="${f.channel.id}"]`)).toHaveText('#General');
  const trigger = page.getByTestId('channel-details-trigger');
  await expect(trigger).toHaveText('#My Channel');
  await expect(page.getByRole('button', { name: 'My Channel, open channel details' })).toBeVisible();
  await expect(page.getByText('my-channel', { exact: true })).toHaveCount(0);
  await shot(page, 'sidebar-header-desktop.png');

  // Channel details: the title as the heading, the slug shown once, beside it.
  await trigger.click();
  const details = page.getByTestId('channel-details');
  await expect(details.getByRole('heading', { name: 'My Channel' })).toBeVisible();
  await expect(details.getByTestId('channel-slug')).toHaveText('#my-channel');
  await shot(page, 'channel-details-desktop.png');
  await page.keyboard.press('Escape');
  await expect(details).toHaveCount(0);

  // Activity in My Channel while Alice is elsewhere: a thread on her message
  // and a plain message from Bob.
  await sidebar.locator(`[data-channel-id="${f.channel.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
  const word = `launchword${Date.now()}`;
  const root = await call(request, 'POST', `/messages/${channelId}`, { content: 'Draft agenda for the launch' }, f.a.accessToken);
  await call(request, 'POST', `/messages/${channelId}`, { content: 'I added the venue options', parentMessageId: root.id }, f.b.accessToken);
  const plain = await call(request, 'POST', `/messages/${channelId}`, { content: `Kickoff is at ten ${word}` }, f.b.accessToken);

  await page.goto('/#/activity');
  const activityItem = page.getByTestId(`activity-item-${channelId}`);
  await expect(activityItem).toContainText('# My Channel');
  await expect(activityItem.getByRole('button', { name: `Open My Channel in ${f.workspace.name}` })).toBeVisible();
  const activityThread = page.getByTestId(`activity-thread-${root.id}`);
  await expect(activityThread).toContainText('Thread in My Channel');
  await expect(activityThread.getByRole('button', { name: 'Open thread in My Channel' })).toBeVisible();
  await expect(page.getByText(/my-channel/)).toHaveCount(0);

  // Threads view and the reply thread panel.
  await page.goto('/#/threads');
  const followed = page.getByTestId(`followed-thread-${root.id}`);
  await expect(followed).toContainText('My Channel');
  await expect(followed).not.toContainText('my-channel');
  await followed.getByRole('button', { name: 'Open thread in My Channel' }).click();
  const panel = page.getByTestId('thread-panel');
  await expect(panel.locator('header')).toContainText('My Channel');
  await expect(panel.getByText('Also send to My Channel', { exact: true })).toBeVisible();

  // Quick switcher: found by its title and by its slug, shown by its title.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('palette-panel');
  const box = palette.getByRole('textbox', { name: 'Search TheChat' });
  await box.fill('My Chan');
  await expect(palette.getByRole('button', { name: 'My Channel, channel', exact: true })).toBeVisible();
  await box.fill('#my-channel');
  await expect(palette.getByRole('button', { name: 'My Channel, channel', exact: true })).toBeVisible();
  // Messages say where they are in running text, and mark it as a channel.
  await box.fill(`?${word}`);
  const hit = palette.getByRole('button', { name: new RegExp(`^Message from Bob Web Test in My Channel: .*${word}`) });
  await expect(hit).toBeVisible();
  await expect(hit).toContainText('# My Channel');
  await page.keyboard.press('Escape');

  // The search page and a message's context page.
  await page.goto(`/#/search?q=${word}`);
  await expect(page.getByTestId('search-result').first()).toContainText('# My Channel');
  await page.goto(`/#/message/${plain.id}`);
  await expect(page.getByTestId('message-context-header')).toContainText('My Channel');
  await expect(page.getByTestId('message-context-header')).not.toContainText('my-channel');

  // Inbox: a bot's request in the channel. The bot still names it by slug.
  const { request: asked } = await call(request, 'POST', '/bot-requests', {
    clientKey: 'web:friendly-names', conversationId: channelId, kind: 'approval', title: 'Publish the launch post?',
    response: { type: 'choice', choices: ['once', 'deny'] },
  }, bot.apiKey);
  expect(asked).toMatchObject({ conversationName: 'my-channel', conversationTitle: 'My Channel' });
  await page.goto('/#/inbox');
  const group = page.getByTestId('inbox-group').filter({ hasText: 'Publish the launch post?' });
  await expect(group).toContainText('# My Channel');
  await expect(group).not.toContainText('my-channel');
  await shot(page, 'inbox-desktop.png');

  expect(errors).toEqual([]);
});

test('phones show the title in the navigation and the header too', async ({ page, request }, info) => {
  test.skip(info.project.name === 'chromium-desktop', 'The desktop journey above covers this');
  const f = await seedWorkspace(request);
  await login(page, f.alice);
  await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
  const channelId = await createMyChannel(page);

  await expect(page.getByTestId('channel-details-trigger')).toHaveText('#My Channel');
  await expect(page.getByText('No messages yet. Start the conversation!')).toBeVisible();
  await shot(page, `header-${info.project.name}.png`);
  await openNavigation(page);
  await expect(page.locator(`[data-channel-id="${channelId}"]`)).toHaveText('#My Channel');
  await expect(page.getByText('my-channel', { exact: true })).toHaveCount(0);
  await shot(page, `sidebar-${info.project.name}.png`);
});
