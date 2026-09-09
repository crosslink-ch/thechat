import { test, expect } from '@playwright/test';
import { call, login, seedWorkspace } from './fixtures';

test('channel task jump preserves task history, send scope, and separate drafts', async ({ page, request }) => {
  const s = await seedWorkspace(request);
  const bot = await call(request, 'POST', '/bots/create', { name: 'Channel helper', kind: 'hermes', workspaceId: s.workspace.id }, s.a.accessToken);
  const thread = await call(request, 'POST', `/conversations/threads/${s.channel.id}`, { botId: bot.id, title: 'Channel task decisions' }, s.a.accessToken);
  await call(request, 'POST', `/messages/${s.channel.id}`, { content: 'Channel task only', threadId: thread.id }, s.a.accessToken);
  await call(request, 'POST', `/messages/${s.channel.id}`, { content: 'General channel only' }, s.a.accessToken);
  await login(page, s.alice);
  const jump = async (query: string) => {
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Search and navigate' });
    await dialog.getByRole('combobox', { name: 'Search', exact: true }).fill(query);
    await expect(dialog.getByRole('option').first()).toContainText(query);
    await page.keyboard.press('Enter');
  };
  await jump('Channel task decisions');
  await expect(page).toHaveURL(new RegExp(`/channel/${s.channel.id}`));
  await expect(page).toHaveURL(new RegExp(`threadId=${thread.id}`));
  await expect(page.getByText('Channel task only', { exact: true })).toBeVisible();
  await expect(page.getByText('General channel only', { exact: true })).toHaveCount(0);
  await page.locator('[contenteditable=true]').first().fill('Task-specific draft');
  await page.getByRole('button', { name: 'Back to channel', exact: true }).click();
  await expect(page).not.toHaveURL(/threadId=/);
  await expect(page.locator('[contenteditable=true]').first()).not.toContainText('Task-specific draft');
  await jump('Channel task decisions');
  await expect(page.locator('[contenteditable=true]').first()).toContainText('Task-specific draft');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => {
    const messages = await call(request, 'GET', `/messages/${s.channel.id}?threadId=${thread.id}`, undefined, s.a.accessToken);
    return messages.some((message: { content: string; threadId: string }) => message.content === 'Task-specific draft' && message.threadId === thread.id);
  }).toBe(true);
});
