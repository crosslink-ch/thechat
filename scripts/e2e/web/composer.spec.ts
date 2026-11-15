import { test, expect, type Page } from '@playwright/test';
import { call, clearCredentialFields, login, seedWorkspace, webURL } from './fixtures';

/**
 * The block composer against the real API, in every place it is used:
 * a channel, a DM, the reply-thread panel and a Hermes task view. Each send
 * goes through the server; the stored Markdown and the rendered message must
 * match what the composer showed.
 */

test.afterEach(async ({ page }) => clearCredentialFields(page));

async function composeBlocks(page: Page, editor: ReturnType<Page['getByRole']>, label: string) {
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type(`${label} `);
  await expect(editor).toContainText(label);
  await page.keyboard.type(':tad');
  await expect(page.getByTestId('emoji-menu')).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('#bul');
  await expect(page.getByTestId('block-menu')).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('**one**');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('```');
  await page.keyboard.type(' ');
  await page.keyboard.type('code();');
  await expect(editor.locator('ul > li')).toHaveCount(2);
  await expect(editor.locator('pre')).toHaveText('code();');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(editor).toHaveText('');
}

const expected = (label: string) => `${label} 🎉\n\n- **one**\n- two\n\n\`\`\`\ncode();\n\`\`\``;

async function expectRendered(page: Page, label: string) {
  const row = page.locator('[data-message-id]').filter({ hasText: `${label} 🎉` }).last();
  await expect(row).toBeVisible();
  await expect(row.locator('.md-content ul > li')).toHaveCount(2);
  await expect(row.locator('.md-content li strong')).toHaveText('one');
  await expect(row.locator('.md-content pre code')).toContainText('code();');
}

async function latestContent(request: Parameters<typeof call>[0], conversationId: string, token: string) {
  const page = await call(request, 'GET', `/messages/${conversationId}?limit=5`, undefined, token);
  const messages = (page.messages ?? page.items ?? page) as { content: string; parentMessageId?: string | null }[];
  return messages.map((message) => message.content);
}

test('blocks, # and : menus in a channel, a DM, the thread panel and a Hermes task', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'Runs once, on desktop Chromium');
  const f = await seedWorkspace(request);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, f.alice);
  const editor = page.getByRole('textbox', { name: 'Message', exact: true });

  // Channel.
  await page.goto(`${webURL}/#/channel/${f.channel.id}`);
  await composeBlocks(page, editor, 'Channel');
  await expectRendered(page, 'Channel');
  await expect.poll(() => latestContent(request, f.channel.id, f.a.accessToken)).toContain(expected('Channel'));

  // DM.
  await page.goto(`${webURL}/#/dm/${f.dm.id}`);
  await composeBlocks(page, editor, 'Direct');
  await expectRendered(page, 'Direct');
  await expect.poll(() => latestContent(request, f.dm.id, f.a.accessToken)).toContain(expected('Direct'));

  // Thread panel: reply to the DM message in a thread.
  const row = page.locator('[data-message-id]').filter({ hasText: 'Direct 🎉' }).last();
  await row.hover();
  await row.getByRole('button', { name: 'Reply in thread', exact: true }).click();
  const threadEditor = page.getByRole('textbox', { name: 'Reply in thread', exact: true });
  await expect(threadEditor).toBeVisible();
  await composeBlocks(page, threadEditor, 'Threaded');
  const panelRow = page.locator('[data-message-id]').filter({ hasText: 'Threaded 🎉' }).last();
  await expect(panelRow.locator('.md-content ul > li')).toHaveCount(2);

  // Hermes task view (a Hermes DM): the composer still runs / commands too.
  const bot = await call(request, 'POST', '/bots/create', { name: 'Composer Hermes', kind: 'hermes', workspaceId: f.workspace.id }, f.a.accessToken);
  const hermes = await call(request, 'POST', '/conversations/dm', { workspaceId: f.workspace.id, otherUserId: bot.userId }, f.a.accessToken);
  await page.goto(`${webURL}/#/dm/${hermes.id}`);
  // The Hermes view remounts its composer once its task list has loaded.
  await expect(page.getByText('No tasks yet')).toBeVisible();
  await page.waitForTimeout(1000);
  await composeBlocks(page, editor, 'Hermes');
  await expectRendered(page, 'Hermes');
  await editor.click();
  await page.keyboard.type('/he');
  await expect(page.getByTestId('slash-command-menu')).toBeVisible();
  await expect(page.getByTestId('slash-command-item-help')).toBeVisible();
  await page.keyboard.press('Escape');

  expect(errors).toEqual([]);
});
