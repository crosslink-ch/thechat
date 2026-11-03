import { test, expect, type Page } from '@playwright/test';
import { call, login, seedWorkspace, clearCredentialFields } from './fixtures';

async function openTasks(page: Page) {
  const toggle = page.getByRole('button', { name: 'Open tasks and activity', exact: true });
  const panel = page.getByRole('complementary', { name: 'Hermes tasks and activity' });
  await expect.poll(async () => (await toggle.isVisible()) || (await panel.isVisible())).toBe(true);
  if (!(await panel.isVisible())) await toggle.click();
  await expect(panel).toBeVisible();
}

test('opening a long task clears its old unread backlog, not siblings or later replies', async ({ browser, request }, info) => {
  test.setTimeout(180_000);
  const f = await seedWorkspace(request);
  const bot = await call(request, 'POST', '/bots/create', {
    name: 'Backlog Test Hermes', kind: 'hermes', workspaceId: f.workspace.id,
  }, f.a.accessToken);
  const dm = await call(request, 'POST', '/conversations/dm', {
    workspaceId: f.workspace.id, otherUserId: bot.userId,
  }, f.a.accessToken);
  const task = async (title: string) => call(request, 'POST', `/conversations/threads/${dm.id}`, {
    botId: bot.id, title,
  }, f.a.accessToken);
  const old = await task('Long task');
  const sibling = await task('Unread sibling');
  const idle = await task('Open task');
  const messageIds: string[] = [];
  // More unread IDs than one read request accepts, and none in the newest page.
  for (let i = 1; i <= 245; i++) {
    const message = await call(request, 'POST', `/messages/${dm.id}`, {
      content: `Historical reply ${i}`, threadId: old.id,
    }, bot.apiKey);
    messageIds.push(message.id);
  }
  await call(request, 'POST', `/activity/conversations/${dm.id}/read`, {
    messageIds: messageIds.slice(-20),
  }, f.a.accessToken);
  await call(request, 'POST', `/messages/${dm.id}`, { content: 'Sibling answer', threadId: sibling.id }, bot.apiKey);
  await call(request, 'POST', `/messages/${dm.id}`, { content: 'General answer' }, bot.apiKey);
  const item = async () => (await call(request, 'GET', '/activity', undefined, f.a.accessToken)).items.find(
    (entry: { conversationId: string }) => entry.conversationId === dm.id,
  );
  const scopes = async () => ((await item())?.unreadThreadIds ?? []).slice().sort();
  expect((await item()).unreadCount).toBe(messageIds.length - 20 + 2);
  let context = await browser.newContext({ ...info.project.use });
  context.setDefaultTimeout(15_000);
  let page = await context.newPage();
  const connections = new WeakMap<Page, { authenticated: boolean }>();
  const observeConnection = (target: Page) => {
    const state = { authenticated: false };
    connections.set(target, state);
    target.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => {
        try {
          if (JSON.parse(payload.toString()).type === 'auth_ok') state.authenticated = true;
        } catch { /* Ignore non-JSON transport frames. */ }
      });
      socket.on('close', () => { state.authenticated = false; });
    });
  };
  observeConnection(page);
  const route = `/#/dm/${dm.id}?threadId=${idle.id}`;
  const row = (id: string) => page.locator(`[data-task-row="${id}"]`);
  const dot = (id: string) => row(id).getByLabel('Unread', { exact: true });
  try {
    await login(page, f.alice);
    await page.goto(route);
    await openTasks(page);
    await expect(dot(old.id)).toBeVisible();
    await row(old.id).getByRole('button', { name: /^Long task/ }).click();
    await expect(page.getByTestId('hermes-dm-chat-scroll').getByText('Historical reply 245', { exact: true })).toBeVisible();
    // Merely visiting the newest page must acknowledge the task's old backlog.
    await expect.poll(scopes).toEqual([null, sibling.id].sort());
    await expect.poll(async () => (await item()).unreadCount).toBe(2);
    await openTasks(page);
    await row(idle.id).getByRole('button', { name: /^Open task/ }).click();
    await expect(page.getByRole('banner', { name: 'Conversation header' })).toContainText('Open task');
    await openTasks(page);
    await expect(dot(old.id)).toHaveCount(0);
    await expect(dot(sibling.id)).toBeVisible();
    await page.screenshot({ path: info.outputPath('backlog-read-sibling-unread.png'), fullPage: true });

    // A reply after leaving is new unread work, not covered by the earlier view.
    await expect.poll(() => connections.get(page)?.authenticated).toBe(true);
    await call(request, 'POST', `/messages/${dm.id}`, { content: 'Reply after leaving', threadId: old.id }, bot.apiKey);
    await expect.poll(scopes).toEqual([null, old.id, sibling.id].sort());
    await expect(dot(old.id)).toBeVisible();
    await row(old.id).getByRole('button', { name: /^Long task/ }).click();
    await expect(page.getByTestId('hermes-dm-chat-scroll').getByText('Reply after leaving', { exact: true })).toBeVisible();
    await expect.poll(scopes).toEqual([null, sibling.id].sort());

    const { cookies } = await context.storageState();
    await clearCredentialFields(page);
    await context.close();
    context = await browser.newContext({ ...info.project.use, storageState: { cookies, origins: [] } });
    context.setDefaultTimeout(15_000);
    page = await context.newPage();
    await page.goto(route);
    await openTasks(page);
    await expect(dot(old.id)).toHaveCount(0);
    await expect(dot(sibling.id)).toBeVisible();
    await expect(page.getByRole('button', { name: /^General Inbox/ }).getByLabel('Unread', { exact: true })).toBeVisible();
  } finally {
    await clearCredentialFields(page);
    await context.close();
  }
});
