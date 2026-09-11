import { test, expect } from '@playwright/test';
import { call, seedWorkspace, login, assertContained, clearCredentialFields } from './fixtures';

test.afterEach(async ({ page }) => clearCredentialFields(page));

test('Hermes DM collapses navigation before Tasks across resize and drawer interactions', async ({ page, request }, info) => {
  const f = await seedWorkspace(request);
  const bot = await call(request, 'POST', '/bots/create', {
    name: 'Hermes', kind: 'hermes', workspaceId: f.workspace.id,
  }, f.a.accessToken);
  const dm = await call(request, 'POST', '/conversations/dm', {
    workspaceId: f.workspace.id, otherUserId: bot.userId,
  }, f.a.accessToken);
  for (const title of ['Review responsive layout', 'Plan next release', 'Check browser coverage']) {
    const task = await call(request, 'POST', `/conversations/threads/${dm.id}`, { botId: bot.id, title }, f.a.accessToken);

    await call(request, 'POST', `/messages/${dm.id}`, { content: `Ready to work on: ${title}.`, threadId: task.id }, bot.apiKey);
  }
  for (let index = 0; index < 25; index++) {
    await call(request, 'POST', `/messages/${dm.id}`, {
      content: `Layout review ${index + 1}\n\nKeep the conversation readable and make task switching easy as the window gets smaller.`,
    }, bot.apiKey);
  }
  await call(request, 'POST', `/messages/${dm.id}`, {
    content: 'The task list should remain visible after workspace navigation moves into its drawer.',
  }, bot.apiKey);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page, f.alice);
  await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
  await page.goto(`/#/dm/${dm.id}`);
  const scroller = page.getByTestId('hermes-dm-chat-scroll');
  const tasksPanel = page.getByRole('complementary', { name: 'Hermes tasks and activity' });
  const navToggle = page.getByRole('button', { name: 'Open navigation', exact: true });
  const tasksToggle = page.getByRole('button', { name: 'Open tasks and activity', exact: true });
  await expect(scroller).toBeVisible();

  for (const width of [1440, 1280, 1100, 1024, 1023, 960, 900, 899, 390, 900, 1024, 1100]) {
    await page.setViewportSize({ width, height: 844 });
    if (width >= 1024) {
      await expect(page.locator('.app-sidebar')).toBeVisible();
      await expect(navToggle).toHaveCount(0);
    } else {
      await expect(page.locator('.app-sidebar')).toHaveCount(0);
      await expect(navToggle).toBeVisible();
    }
    if (width >= 900) {
      await expect(tasksPanel).toBeVisible();
      await expect(tasksToggle).toHaveCount(0);
      await assertContained(page, '.hermes-runtime-panel');
      const panel = (await tasksPanel.boundingBox())!;
      const chat = (await scroller.boundingBox())!;
      // Both sidebars now remain inline at narrower desktop widths.
      expect(chat.width).toBeGreaterThan(width >= 1024 && width < 1280 ? 350 : 450);
      expect(chat.x + chat.width).toBeLessThanOrEqual(panel.x + 1);
      expect(Math.abs(chat.y - panel.y)).toBeLessThan(2);
    } else {
      await expect(tasksPanel).toHaveCount(0);
      await expect(tasksToggle).toBeVisible();
    }
    await assertContained(page, '[data-testid="hermes-dm-chat-scroll"]');
    await assertContained(page, '[contenteditable=true]');
    await assertContained(page, '[title="Send message"]');
    expect(await scroller.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.screenshot({ path: info.outputPath(`layout-${width}.png`), fullPage: true });
  }

  await page.setViewportSize({ width: 960, height: 844 });
  await navToggle.click();
  await expect(page.getByRole('dialog', { name: 'Workspace navigation' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(navToggle).toBeFocused();
  await tasksPanel.getByRole('button', { name: /Review responsive layout/ }).click();
  await expect(scroller.getByText('Ready to work on: Review responsive layout.', { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await tasksToggle.click();
  await expect(page.getByRole('dialog', { name: 'Tasks and activity' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('phone-tasks-drawer.png'), fullPage: true });
  await tasksPanel.getByRole('button', { name: /Plan next release/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(scroller.getByText('Ready to work on: Plan next release.', { exact: true })).toBeVisible();
  await expect(tasksToggle).toBeFocused();

  await tasksToggle.click();
  await page.setViewportSize({ width: 900, height: 844 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(tasksPanel).toBeVisible();
  await page.setViewportSize({ width: 899, height: 844 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await navToggle.click();
  await page.setViewportSize({ width: 1024, height: 844 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.app-sidebar')).toBeVisible();
  await page.setViewportSize({ width: 1023, height: 844 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});
