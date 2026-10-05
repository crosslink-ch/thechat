import { test, expect } from '@playwright/test';
import { webURL, seedWorkspace, login, call, clearCredentialFields } from './fixtures';

test.afterEach(async ({ page }) => clearCredentialFields(page));

test('Rename command edits only the current task and persists after reload', async ({ page, request }, info) => {
  const f = await seedWorkspace(request);
  const bot = await call(request, 'POST', '/bots/create', {
    name: 'Rename acceptance Hermes', kind: 'hermes', workspaceId: f.workspace.id,
  }, f.a.accessToken);
  const dm = await call(request, 'POST', '/conversations/dm', {
    workspaceId: f.workspace.id, otherUserId: bot.userId,
  }, f.a.accessToken);
  const first = await call(request, 'POST', `/conversations/threads/${dm.id}`, {
    botId: bot.id, title: 'Untouched task',
  }, f.a.accessToken);
  const active = await call(request, 'POST', `/conversations/threads/${dm.id}`, {
    botId: bot.id, title: 'Active task before rename',
  }, f.a.accessToken);

  await login(page, f.alice);
  await page.goto(`${webURL}/#/dm/${dm.id}?threadId=${active.id}`);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await expect(page.locator('header').getByText(active.title, { exact: true })).toBeVisible();
  await page.keyboard.press('Control+Shift+P');
  const palette = page.getByTestId('palette-panel');
  await palette.getByPlaceholder('Type a command...').fill('Rename');
  await expect(palette.getByRole('button', { name: 'Rename', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('rename-command.png') });
  await palette.getByPlaceholder('Type a command...').press('Enter');
  await expect(palette).toHaveCount(0);
  const input = page.getByRole('textbox', { name: 'Task name' });
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(active.title);
  expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, active.title.length]);
  await page.screenshot({ path: info.outputPath('rename-editor.png') });
  await input.fill('Renamed from command palette');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  const persisted = await call(request, 'GET', `/conversations/threads/${dm.id}`, undefined, f.a.accessToken);
  expect(persisted.items.find((thread: any) => thread.id === active.id).title).toBe('Renamed from command palette');
  expect(persisted.items.find((thread: any) => thread.id === first.id).title).toBe(first.title);

  await page.reload();
  await expect(page.locator('header').getByText('Renamed from command palette', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('renamed-task.png') });
});
