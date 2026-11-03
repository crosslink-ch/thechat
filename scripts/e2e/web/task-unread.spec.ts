import { test, expect, type Page } from '@playwright/test';
import { call, login, seedWorkspace, clearCredentialFields } from './fixtures';

async function openTasks(page: Page) {
  const toggle = page.getByRole('button', { name: 'Open tasks and activity', exact: true });
  const panel = page.getByRole('complementary', { name: 'Hermes tasks and activity' });
  // The route loads asynchronously. On a phone the toggle is not present yet
  // immediately after navigation, and the panel only mounts when it is opened.
  await expect.poll(async () => (await toggle.isVisible()) || (await panel.isVisible())).toBe(true);
  if (!(await panel.isVisible())) await toggle.click();
  await expect(panel).toBeVisible();
}

// Real API + production shared client. New contexts deliberately carry only the
// auth cookie, never JS state or local storage, so a local unread cache cannot
// accidentally make restart/offline recovery pass.
test('task and General unread survive client restart and clear independently', async ({ browser, request }, info) => {
  test.setTimeout(120_000);
  const f = await seedWorkspace(request);
  const bot = await call(request, 'POST', '/bots/create', {
    name: 'Hermes Unread Test', kind: 'hermes', workspaceId: f.workspace.id,
  }, f.a.accessToken);
  const dm = await call(request, 'POST', '/conversations/dm', {
    workspaceId: f.workspace.id, otherUserId: bot.userId,
  }, f.a.accessToken);
  const project = await call(request, 'POST', `/conversations/projects/${dm.id}`, {
    name: 'Unread regression',
  }, f.a.accessToken);
  const task = async (title: string, projectId?: string) => call(request, 'POST', `/conversations/threads/${dm.id}`, {
    botId: bot.id, title, ...(projectId ? { projectId } : {}),
  }, f.a.accessToken);
  const a = await task('Review persistence', project.id);
  const b = await task('Check sibling task');
  const idle = await task('Open task');
  let context = await browser.newContext({ ...info.project.use });
  context.setDefaultTimeout(15_000);
  let page = await context.newPage();
  const route = `/#/dm/${dm.id}?threadId=${idle.id}`;
  const activity = () => call(request, 'GET', '/activity', undefined, f.a.accessToken);
  const row = (id: string) => page.locator(`[data-task-row="${id}"]`);
  const dot = (id: string) => row(id).getByLabel('Unread', { exact: true });
  const general = () => page.getByRole('button', { name: /^General Inbox/ });
  const scopes = async () => ((await activity()).items.find((item: { conversationId: string }) => item.conversationId === dm.id)?.unreadThreadIds ?? []).slice().sort();
  const assertUnread = async () => {
    await openTasks(page);
    await expect(dot(b.id)).toBeVisible();
    await expect(general().getByLabel('Unread', { exact: true })).toBeVisible();
    // The collapsed project badge must restore too, not just visible task rows.
    const projectButton = page.getByRole('group', { name: 'Project Unread regression', exact: true }).locator('button[aria-expanded]:not([aria-haspopup])');
    if (await projectButton.getAttribute('aria-expanded') === 'false') {
      await expect(projectButton.getByLabel('Unread tasks', { exact: true })).toBeVisible();
      await projectButton.click();
    }
    await expect(dot(a.id)).toBeVisible();
  };
  try {
    await login(page, f.alice);
    await page.goto(route);
    await openTasks(page);
    await expect(row(idle.id)).toBeVisible();
    // Establish a genuinely connected client before sending offscreen replies.
    await expect.poll(async () => page.locator('[data-task-row]').count()).toBe(2);
    await call(request, 'POST', `/messages/${dm.id}`, { content: 'Answer for persistence', threadId: a.id }, bot.apiKey);
    await call(request, 'POST', `/messages/${dm.id}`, { content: 'Answer for sibling', threadId: b.id }, bot.apiKey);
    await call(request, 'POST', `/messages/${dm.id}`, { content: 'General answer' }, bot.apiKey);
    await assertUnread();
    await page.screenshot({ path: info.outputPath('before-restart.png'), fullPage: true });

    const { cookies } = await context.storageState();
    await clearCredentialFields(page);
    await context.close();
    // Arrives with no client online; a latest-message-only projection would
    // restore B but silently omit A and General.
    await call(request, 'POST', `/messages/${dm.id}`, { content: 'New answer while closed', threadId: b.id }, bot.apiKey);
    context = await browser.newContext({ ...info.project.use, storageState: { cookies, origins: [] } });
    context.setDefaultTimeout(15_000);
    page = await context.newPage();
    await page.goto(route);
    await assertUnread();
    await expect.poll(scopes).toEqual([null, a.id, b.id].sort());
    await page.screenshot({ path: info.outputPath('after-restart.png'), fullPage: true });

    await row(a.id).getByRole('button', { name: /^Review persistence/ }).click();
    await expect(page.getByTestId('hermes-dm-chat-scroll').getByText('Answer for persistence', { exact: true })).toBeVisible();
    await expect.poll(scopes).toEqual([null, b.id].sort());
    await page.goto(route);
    await openTasks(page);
    await expect(dot(b.id)).toBeVisible();
    await expect(general().getByLabel('Unread', { exact: true })).toBeVisible();
    const projectButton = page.getByRole('group', { name: 'Project Unread regression', exact: true }).locator('button[aria-expanded]:not([aria-haspopup])');
    if (await projectButton.getAttribute('aria-expanded') === 'false') await projectButton.click();
    await expect(dot(a.id)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('one-task-read.png'), fullPage: true });

    await page.goto('/#/activity');
    await page.getByRole('button', { name: 'Mark all as read', exact: true }).click();
    await expect.poll(scopes).toEqual([]);
    await context.close();
    context = await browser.newContext({ ...info.project.use, storageState: { cookies, origins: [] } });
    context.setDefaultTimeout(15_000);
    page = await context.newPage();
    await page.goto(route);
    await openTasks(page);
    await expect(row(b.id)).toBeVisible();
    await expect(page.getByLabel('Unread', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Unread tasks', { exact: true })).toHaveCount(0);
  } finally {
    await clearCredentialFields(page);
    await context.close();
  }
});
