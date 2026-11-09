import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { call, clearCredentialFields, identity, login, openNavigation, seedWorkspace, webURL } from './fixtures';

test.afterEach(async ({ page }) => clearCredentialFields(page));

/** PR screenshots go here when set; otherwise into the test's output folder. */
async function shot(page: Page, name: string, outputPath: (name: string) => string) {
  const dir = process.env.THECHAT_SEARCH_SCREENSHOTS;
  if (dir) mkdirSync(dir, { recursive: true });
  // Dialogs fade and scale in: capture the settled frame, not the first one.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  await page.screenshot({ path: dir ? join(dir, name) : outputPath(name) });
}

async function seedSearchWorld(request: Parameters<typeof seedWorkspace>[0]) {
  const f = await seedWorkspace(request);
  // A second company Alice belongs to: the switcher spans both.
  const other = await call(request, 'POST', '/workspaces/create', { name: 'TouchPoint' }, f.a.accessToken);
  const otherDetail = await call(request, 'GET', `/workspaces/${other.id}`, undefined, f.a.accessToken);
  await call(request, 'POST', '/conversations/channel', { workspaceId: f.workspace.id, name: 'releases' }, f.a.accessToken)
    .catch(() => null);
  const bot = await call(request, 'POST', '/bots/create', {
    name: 'Koda', kind: 'hermes', workspaceId: f.workspace.id,
  }, f.a.accessToken);
  const kodaDm = await call(request, 'POST', '/conversations/dm', {
    workspaceId: f.workspace.id, otherUserId: bot.userId,
  }, f.a.accessToken);
  const invoices = await call(request, 'POST', `/conversations/threads/${kodaDm.id}`, {
    botId: bot.id, title: 'Invoice cleanup for October',
  }, f.a.accessToken);
  const deploy = await call(request, 'POST', `/conversations/threads/${kodaDm.id}`, {
    botId: bot.id, title: 'Deploy checklist',
  }, f.a.accessToken);

  const post = (conversationId: string, content: string, token: string, threadId?: string) =>
    call(request, 'POST', `/messages/${conversationId}`, { content, ...(threadId ? { threadId } : {}) }, token);
  await post(f.channel.id, 'Kickoff notes are in the shared drive', f.b.accessToken);
  await post(f.channel.id, 'The staging password rotates every Tuesday, ask Bob for the new one', f.b.accessToken);
  await post(f.channel.id, 'Thanks, noted. I will update the runbook', f.a.accessToken);
  await post(f.dm.id, 'Can you send me the staging URL again?', f.a.accessToken);
  await post(kodaDm.id, 'Reconcile the October invoices against the bank export', f.a.accessToken, invoices.id);
  await post(kodaDm.id, 'Check the staging deploy before Friday', f.a.accessToken, deploy.id);
  await post(otherDetail.channels[0].id, 'TouchPoint staging is frozen until Monday', f.a.accessToken);
  const target = await post(f.channel.id, 'Final reminder: staging maintenance window is Sunday 06:00', f.b.accessToken);
  return { ...f, other, bot, kodaDm, invoices, deploy, target };
}

async function openSwitcher(page: Page, isPhone: boolean) {
  if (isPhone) {
    await openNavigation(page);
    await page.getByTestId('sidebar-search').click();
  } else {
    await page.keyboard.press('Control+k');
  }
  const panel = page.getByTestId('palette-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test('quick switcher jumps anywhere and message search opens the hit in context', async ({ page, request }, info) => {
  const isPhone = info.project.name.includes('phone');
  const w = await seedSearchWorld(request);
  await login(page, w.alice);
  await page.goto(`${webURL}/#/channel/${w.channel.id}`);
  await expect(page.getByText('Kickoff notes are in the shared drive')).toBeVisible();

  // A loosely typed name finds the agent; Enter opens its DM in General.
  let panel = await openSwitcher(page, isPhone);
  const input = panel.getByRole('textbox', { name: 'Search TheChat' });
  await input.fill('kda');
  await expect(panel.locator('[data-active="true"]')).toHaveAccessibleName(/^Koda, Hermes agent/);
  await input.press('Enter');
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/dm/${w.kodaDm.id}`));
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();

  // A task by its title, then back to the DM by name: General, not the task.
  panel = await openSwitcher(page, isPhone);
  await panel.getByRole('textbox', { name: 'Search TheChat' }).fill('invoice');
  await expect(panel.locator('[data-active="true"]')).toHaveAccessibleName(/^Invoice cleanup for October, task in Koda/);
  if (!isPhone) await shot(page, `switcher-task-${info.project.name}.png`, info.outputPath);
  await panel.getByRole('textbox', { name: 'Search TheChat' }).press('Enter');
  await expect(page).toHaveURL(new RegExp(`threadId=${w.invoices.id}`));
  await expect(page.locator('[data-message-id]').filter({ hasText: 'Reconcile the October invoices' })).toBeVisible();
  panel = await openSwitcher(page, isPhone);
  await panel.getByRole('textbox', { name: 'Search TheChat' }).fill('koda');
  await panel.getByRole('textbox', { name: 'Search TheChat' }).press('Enter');
  // The desktop task list still previews the task; the open chat is General.
  await expect(page.getByRole('banner', { name: 'Conversation header' }).getByText('General', { exact: true })).toBeVisible();
  await expect(page.locator('[data-message-id]').filter({ hasText: 'Reconcile the October invoices' })).toHaveCount(0);

  // The other workspace's channel, by name: the workspace switches with it.
  panel = await openSwitcher(page, isPhone);
  await panel.getByRole('textbox', { name: 'Search TheChat' }).fill('#general');
  await expect(panel.getByRole('button', { name: 'general, channel, TouchPoint' })).toBeVisible();
  await panel.getByRole('button', { name: 'general, channel, TouchPoint' }).click();
  await expect(page.getByText('TouchPoint staging is frozen until Monday')).toBeVisible();

  // Message text across both workspaces, previewed under the places.
  panel = await openSwitcher(page, isPhone);
  await panel.getByRole('textbox', { name: 'Search TheChat' }).fill('?staging');
  const results = panel.getByTestId('palette-item');
  await expect(results.filter({ hasText: 'maintenance window' })).toBeVisible();
  await expect(results.filter({ hasText: 'TouchPoint staging is frozen' })).toBeVisible();
  // Bob's private DM with Alice is hers; Koda's task is hers; all are found.
  await expect(results.filter({ hasText: 'Check the staging deploy before Friday' })).toBeVisible();
  await shot(page, `switcher-messages-${info.project.name}.png`, info.outputPath);
  await results.filter({ hasText: 'maintenance window' }).click();
  await expect(page).toHaveURL(new RegExp(`/message/${w.target.id}`));
  const context = page.getByTestId('message-context');
  await expect(context.locator('[data-search-target="true"]')).toContainText('Final reminder: staging maintenance window');
  await expect(context.getByText('The staging password rotates every Tuesday')).toBeVisible();
  await shot(page, `message-context-${info.project.name}.png`, info.outputPath);

  // The link is shareable: reload keeps it; "Open conversation" goes live,
  // at the same message.
  await page.reload();
  await expect(page.getByTestId('message-context').locator('[data-search-target="true"]')).toBeVisible();
  await page.getByRole('button', { name: 'Open conversation' }).click();
  await expect(page).toHaveURL(new RegExp(`/channel/${w.channel.id}`));
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await expectOpenedAt(page, w.target.id);
});

/** The live chat shows the message in view, highlighted. */
async function expectOpenedAt(page: Page, messageId: string) {
  const row = page.locator(`[data-message-id="${messageId}"]`);
  await expect(row).toHaveAttribute('data-message-highlighted', 'true');
  await expect(row).toBeInViewport();
}

test('"Open conversation" opens the live chat at a message far back', async ({ page, request }, info) => {
  const isPhone = info.project.name.includes('phone');
  const f = await seedWorkspace(request);
  const post = (content: string) => call(request, 'POST', `/messages/${f.channel.id}`, { content }, f.b.accessToken);
  const target = await post('The vendor contract renews on 1 March');
  // More than two pages of newer messages: the chat first loads only the latest.
  for (let index = 0; index < 45; index += 1) await post(`Status update ${index + 1}`);

  await login(page, f.alice);
  await page.goto(`${webURL}/#/message/${target.id}`);
  await expect(page.getByTestId('message-context').locator('[data-search-target="true"]')).toContainText('vendor contract');
  await page.getByRole('button', { name: 'Open conversation' }).click();

  await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
  await expect(page.getByTestId('message-context')).toHaveCount(0);
  await expectOpenedAt(page, target.id);
  // Not the newest messages, and the view stays there.
  await expect(page.locator('[data-message-id]').filter({ hasText: 'Status update 45' })).not.toBeInViewport();
  await page.waitForTimeout(1000);
  await expect(page.locator(`[data-message-id="${target.id}"]`)).toBeInViewport();
  await shot(page, `open-conversation-${info.project.name}.png`, info.outputPath);

  // A new message arriving meanwhile does not pull the view away.
  await post('Fresh news after the jump');
  await expect(page.getByText('Fresh news after the jump')).toBeAttached();
  await expect(page.locator(`[data-message-id="${target.id}"]`)).toBeInViewport();

  // The highlight fades; the chat works normally from here.
  await expect(page.locator(`[data-message-id="${target.id}"]`)).not.toHaveAttribute('data-message-highlighted', 'true', { timeout: 10_000 });
  if (!isPhone) {
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Back to the bottom');
    await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
    await expect(page.locator('[data-message-id]').filter({ hasText: 'Back to the bottom' })).toBeInViewport();
  }
});

test('"Open task" opens the Hermes task at the message', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'One browser covers the task variant');
  const w = await seedSearchWorld(request);
  const post = (content: string) =>
    call(request, 'POST', `/messages/${w.kodaDm.id}`, { content, threadId: w.invoices.id }, w.a.accessToken);
  const target = await post('Invoice 2026-114 is missing its VAT number');
  for (let index = 0; index < 30; index += 1) await post(`Invoice check ${index + 1}`);

  await login(page, w.alice);
  await page.goto(`${webURL}/#/message/${target.id}`);
  await page.getByRole('button', { name: 'Open task' }).click();
  await expect(page).toHaveURL(new RegExp(`/dm/${w.kodaDm.id}.*threadId=${w.invoices.id}`));
  await expectOpenedAt(page, target.id);
  await expect(page.locator('[data-message-id]').filter({ hasText: 'Invoice check 30' })).not.toBeInViewport();
});

test('full results page pages through results; others never see private messages', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'One browser covers the results page');
  const w = await seedSearchWorld(request);
  for (let index = 0; index < 35; index += 1) {
    await call(request, 'POST', `/messages/${w.channel.id}`, { content: `Batch ${index} of the quarterly report draft` }, w.b.accessToken);
  }
  await login(page, w.alice);
  await page.goto(`${webURL}/#/`);
  // From the switcher: jump into the workspace, then open all results.
  let panel = await openSwitcher(page, false);
  await panel.getByRole('textbox', { name: 'Search TheChat' }).fill('releases');
  await panel.getByRole('textbox', { name: 'Search TheChat' }).press('Enter');
  await expect(page).toHaveURL(/\/channel\//);
  panel = await openSwitcher(page, false);
  await panel.getByRole('textbox', { name: 'Search TheChat' }).fill('"quarterly report"');
  await panel.getByRole('button', { name: 'Search all messages for "quarterly report"' }).click();
  await expect(page).toHaveURL(/\/search\?q=/);
  const rows = page.getByTestId('search-result');
  await expect(rows).toHaveCount(30);
  // The URL is the state: a reload shows the same results.
  await page.reload();
  await expect(rows).toHaveCount(30);
  await shot(page, `search-page-${info.project.name}.png`, info.outputPath);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(rows).toHaveCount(35);

  // A third person outside the DM and the second workspace sees neither.
  const carol = identity('Carol Web Test');
  const c = await call(request, 'POST', '/auth/register', carol);
  const invite = await call(request, 'POST', '/invites/create', { workspaceId: w.workspace.id, email: carol.email }, w.a.accessToken);
  await call(request, 'POST', '/invites/accept', { inviteId: invite.id }, c.accessToken);
  const forCarol = await call(request, 'GET', `/search/messages?q=staging`, undefined, c.accessToken);
  const visible = forCarol.results.map((hit: { snippet: string }) => hit.snippet).join('\n');
  expect(visible).toContain('maintenance window');
  expect(visible).not.toContain('staging URL again');
  expect(visible).not.toContain('TouchPoint staging');
  expect(visible).not.toContain('staging deploy before Friday');
});
