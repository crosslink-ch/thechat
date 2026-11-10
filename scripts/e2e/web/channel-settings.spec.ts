import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { apiURL, call, clearCredentialFields, identity, login, webURL } from './fixtures';

test.afterEach(async ({ page }) => clearCredentialFields(page));

/** PR screenshots go here when set; otherwise into the test's output folder. */
async function shot(page: Page, name: string, outputPath: (name: string) => string) {
  const dir = process.env.THECHAT_CHANNEL_SETTINGS_SCREENSHOTS;
  if (dir) mkdirSync(dir, { recursive: true });
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  await page.screenshot({ path: dir ? join(dir, name) : outputPath(name) });
}

/** Morgan owns the workspace; #leadership is private with Morgan and Avery. */
async function seed(request: Parameters<typeof call>[0]) {
  const morgan = identity('Morgan Owner');
  const avery = identity('Avery Member');
  const nora = identity('Nora Newcomer');
  const m = await call(request, 'POST', '/auth/register', morgan);
  const a = await call(request, 'POST', '/auth/register', avery);
  const n = await call(request, 'POST', '/auth/register', nora);
  const workspace = await call(request, 'POST', '/workspaces/create', { name: `Acme ${randomUUID().slice(0, 6)}` }, m.accessToken);
  for (const [person, session] of [[avery, a], [nora, n]] as const) {
    const invite = await call(request, 'POST', '/invites/create', { workspaceId: workspace.id, email: person.email }, m.accessToken);
    await call(request, 'POST', '/invites/accept', { inviteId: invite.id }, session.accessToken);
  }
  const detail = await call(request, 'GET', `/workspaces/${workspace.id}`, undefined, m.accessToken);
  const leadership = await call(
    request,
    'POST',
    '/conversations/channel',
    { workspaceId: workspace.id, name: 'Leadership', isPrivate: true, memberIds: [a.user.id] },
    m.accessToken,
  );
  const history = `Q3 reorg plan ${randomUUID().slice(0, 8)}`;
  await call(request, 'POST', `/messages/${leadership.id}`, { content: history }, m.accessToken);
  return { morgan, avery, nora, m, a, n, workspace, general: detail.channels[0], leadership, history };
}

async function peer(browser: Browser, viewport: { width: number; height: number }, person: ReturnType<typeof identity>) {
  const context = await browser.newContext({ baseURL: webURL, ignoreHTTPSErrors: true, viewport });
  const page = await context.newPage();
  await login(page, person);
  return { context, page };
}

/**
 * On a phone the sidebar is a drawer. Opening and closing are awaited to their
 * end state: a one-shot visibility check can land in the drawer's transition.
 */
async function openNavigation(page: Page) {
  const search = page.getByTestId('sidebar-search');
  const toggle = page.getByRole('button', { name: 'Open navigation', exact: true });
  await expect(search.or(toggle).first()).toBeVisible();
  await expect(async () => {
    if (!(await search.isVisible())) await toggle.click({ timeout: 2_000 });
    await expect(search).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

async function closeNavigation(page: Page, isPhone: boolean) {
  if (!isPhone) return;
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sidebar-search')).toBeHidden();
}

/** A channel's row in the sidebar (owners also get a "Manage" button beside it). */
const sidebarChannel = (target: Page, channel: { id: string }) => target.locator(`[data-channel-id="${channel.id}"]`);
const composer = (target: Page) => target.getByRole('textbox', { name: 'Message', exact: true });
const message = (target: Page, text: string) => target.locator('[data-message-id]').filter({ hasText: text });

async function openDetails(target: Page) {
  await target.getByTestId('channel-details-trigger').click();
  const dialog = target.getByTestId('channel-details');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function searchFor(page: Page, isPhone: boolean, query: string) {
  if (isPhone) {
    await openNavigation(page);
    await page.getByTestId('sidebar-search').click();
  } else {
    await page.keyboard.press('Control+k');
  }
  const panel = page.getByTestId('palette-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('textbox', { name: 'Search TheChat' }).fill(query);
  return panel;
}

test('channel details: members, adding and removing people, and archiving, live for everyone connected', async ({ page, request, browser }, info) => {
  const isPhone = info.project.name.includes('phone');
  const viewport = page.viewportSize()!;
  const w = await seed(request);
  const leadershipURL = new RegExp(`/channel/${w.leadership.id}`);
  const generalURL = new RegExp(`/channel/${w.general.id}`);

  // Avery (a member) and Nora (not in #leadership) are connected the whole time.
  const avery = await peer(browser, viewport, w.avery);
  const nora = await peer(browser, viewport, w.nora);
  try {
    await expect(nora.page).toHaveURL(generalURL);
    await openNavigation(nora.page);
    await expect(sidebarChannel(nora.page, w.general)).toBeVisible();
    await expect(sidebarChannel(nora.page, w.leadership)).toHaveCount(0);
    await closeNavigation(nora.page, isPhone);

    // --- The details view, opened from the channel header -------------------
    await login(page, w.morgan);
    await openNavigation(page);
    await sidebarChannel(page, w.leadership).click();
    await expect(page).toHaveURL(leadershipURL);
    let dialog = await openDetails(page);
    await expect(dialog.getByRole('heading', { name: 'leadership' })).toBeVisible();
    await expect(dialog.getByTestId('channel-visibility')).toHaveText('Private channel');
    const members = dialog.getByTestId('channel-members').getByRole('listitem');
    await expect(members).toHaveCount(2);
    await expect(members.filter({ hasText: 'Morgan Owner' })).toContainText('Owner');
    await expect(members.filter({ hasText: 'Morgan Owner' })).toContainText('(you)');
    await expect(members.filter({ hasText: 'Avery Member' })).toContainText('Member');
    // The owner cannot remove themselves.
    await expect(dialog.getByRole('button', { name: 'Remove Morgan Owner' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Remove Avery Member' })).toBeVisible();
    await shot(page, `details-${info.project.name}.png`, (name) => info.outputPath(name));

    // --- Adding a workspace member -----------------------------------------
    await dialog.getByRole('button', { name: 'Add people' }).click();
    const picker = dialog.getByRole('form', { name: 'Add people' });
    // Only people who are not in the channel yet are offered.
    await expect(picker.getByRole('checkbox')).toHaveCount(1);
    await picker.getByRole('textbox', { name: 'Search workspace members' }).fill('nobody like this');
    await expect(picker.getByText('No one matches.')).toBeVisible();
    await picker.getByRole('textbox', { name: 'Search workspace members' }).fill('nora');
    await picker.getByRole('checkbox', { name: 'Add Nora Newcomer' }).check();
    await shot(page, `add-member-${info.project.name}.png`, (name) => info.outputPath(name));
    await picker.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(members).toHaveCount(3);
    await expect(members.filter({ hasText: 'Nora Newcomer' })).toContainText('Member');
    await expect(picker).toHaveCount(0);

    // Nora sees the channel at once, with its lock and its earlier history.
    await openNavigation(nora.page);
    const noraChannel = sidebarChannel(nora.page, w.leadership);
    await expect(noraChannel).toBeVisible();
    await expect(noraChannel.getByRole('img', { name: 'Private channel' })).toBeVisible();
    await noraChannel.click();
    await expect(nora.page).toHaveURL(leadershipURL);
    await expect(message(nora.page, w.history)).toBeVisible();
    const fromNora = `Glad to be here ${randomUUID().slice(0, 8)}`;
    await composer(nora.page).fill(fromNora);
    await nora.page.getByTitle('Send message', { exact: true }).click();
    await expect(message(nora.page, fromNora)).toBeVisible();

    // Avery, who was already a member, sees the new member without reloading.
    await openNavigation(avery.page);
    await sidebarChannel(avery.page, w.leadership).click();
    await expect(message(avery.page, fromNora)).toBeVisible();
    const averyDialog = await openDetails(avery.page);
    await expect(averyDialog.getByTestId('channel-members').getByRole('listitem')).toHaveCount(3);
    // A regular member reads the list and cannot change anything.
    await expect(averyDialog.getByRole('button', { name: 'Add people' })).toHaveCount(0);
    await expect(averyDialog.getByRole('button', { name: /^Remove / })).toHaveCount(0);
    await expect(averyDialog.getByRole('button', { name: 'Archive' })).toHaveCount(0);
    await expect(averyDialog.getByRole('button', { name: 'Rename' })).toHaveCount(0);
    await expect(averyDialog.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    // --- Removing a member --------------------------------------------------
    await dialog.getByRole('button', { name: 'Remove Nora Newcomer' }).click();
    await expect(members).toHaveCount(2);
    // Nora is looking at the channel: she is taken out of it at once.
    await expect(nora.page).toHaveURL(generalURL);
    await expect(nora.page.getByText(w.history)).toHaveCount(0);
    await openNavigation(nora.page);
    await expect(sidebarChannel(nora.page, w.general)).toBeVisible();
    await expect(sidebarChannel(nora.page, w.leadership)).toHaveCount(0);
    await closeNavigation(nora.page, isPhone);
    // Avery's open member list follows.
    await expect(averyDialog.getByTestId('channel-members').getByRole('listitem')).toHaveCount(2);
    await averyDialog.getByRole('button', { name: 'Close channel details' }).click();
    // The server agrees, also for what Nora could read a moment ago.
    const asNora = (method: string, path: string, data?: unknown) =>
      request.fetch(`${apiURL}${path}`, {
        method, ...(data === undefined ? {} : { data }),
        headers: { authorization: `Bearer ${w.n.accessToken}` },
      });
    expect((await asNora('GET', `/messages/${w.leadership.id}`)).status()).toBe(403);
    expect((await asNora('POST', `/messages/${w.leadership.id}`, { content: 'still here?' })).status()).toBe(403);
    const panel = await searchFor(nora.page, isPhone, `?${w.history}`);
    await expect(panel.getByText(/No messages/i)).toBeVisible();
    await nora.page.keyboard.press('Escape');
    // A guessed link no longer opens it either.
    await nora.page.goto(`${webURL}/#/channel/${w.leadership.id}`);
    await expect(nora.page).toHaveURL(generalURL);

    // --- Archiving ----------------------------------------------------------
    await dialog.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(dialog.getByTestId('channel-archived-badge')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Unarchive' })).toBeVisible();
    // Rename is not offered while archived; delete stays the permanent option.
    await expect(dialog.getByRole('button', { name: 'Rename' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Delete' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close channel details' }).click();

    // Read-only for the owner: history stays, the composer is gone.
    await expect(page.getByTestId('archived-channel-notice')).toBeVisible();
    await expect(composer(page)).toHaveCount(0);
    await expect(message(page, w.history)).toBeVisible();
    await expect(page.getByTestId('channel-details-trigger')).toContainText('Archived');
    await shot(page, `archived-${info.project.name}.png`, (name) => info.outputPath(name));

    // Avery is in the channel: it turns read-only under her, without reload.
    await expect(avery.page.getByTestId('archived-channel-notice')).toBeVisible();
    await expect(composer(avery.page)).toHaveCount(0);
    await expect(message(avery.page, w.history)).toBeVisible();
    // It left the active list for a collapsed "Archived" section.
    await openNavigation(avery.page);
    const archivedSection = avery.page.getByTestId('archived-channels');
    await expect(archivedSection.locator(`[data-channel-id="${w.leadership.id}"]`)).toBeVisible();
    await shot(avery.page, `archived-sidebar-${info.project.name}.png`, (name) => info.outputPath(name));
    await sidebarChannel(avery.page, w.general).click();
    await expect(avery.page).toHaveURL(generalURL);
    await openNavigation(avery.page);
    // Away from it, the section is closed and the channel is out of sight.
    await expect(avery.page.getByRole('button', { name: 'Archived (1)' })).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebarChannel(avery.page, w.leadership)).toHaveCount(0);
    await closeNavigation(avery.page, isPhone);
    // Its history is still found by search and opens from there.
    const hits = await searchFor(avery.page, isPhone, `?${w.history}`);
    await hits.getByRole('button', { name: `Message from Morgan Owner in #leadership: ${w.history}` }).click();
    await expect(avery.page).toHaveURL(/\/message\//);
    await expect(avery.page.getByText(w.history).first()).toBeVisible();
    await avery.page.getByRole('button', { name: 'Open conversation' }).click();
    await expect(avery.page).toHaveURL(leadershipURL);
    await expect(message(avery.page, w.history)).toBeVisible();
    await expect(avery.page.getByTestId('archived-channel-notice')).toBeVisible();
    // The server refuses a write that skips the UI.
    const refused = await request.fetch(`${apiURL}/messages/${w.leadership.id}`, {
      method: 'POST', data: { content: 'one more thing' },
      headers: { authorization: `Bearer ${w.a.accessToken}` },
    });
    expect(refused.status()).toBe(403);

    // A reload keeps it archived and readable.
    await avery.page.reload();
    await expect(avery.page.getByTestId('archived-channel-notice')).toBeVisible();
    await expect(message(avery.page, w.history)).toBeVisible();

    // --- Unarchiving, from the notice's shortcut to the details -------------
    await page.getByTestId('archived-channel-notice').getByRole('button', { name: 'Channel details' }).click();
    dialog = page.getByTestId('channel-details');
    await dialog.getByRole('button', { name: 'Unarchive' }).click();
    await expect(dialog.getByTestId('channel-archived-badge')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close channel details' }).click();
    await expect(composer(page)).toBeVisible();
    // Avery can post again without reloading.
    await expect(avery.page.getByTestId('archived-channel-notice')).toHaveCount(0);
    const back = `Back in business ${randomUUID().slice(0, 8)}`;
    await composer(avery.page).fill(back);
    await avery.page.getByTitle('Send message', { exact: true }).click();
    await expect(message(page, back)).toBeVisible();
    await openNavigation(avery.page);
    await expect(avery.page.getByTestId('archived-channels')).toHaveCount(0);
    await expect(sidebarChannel(avery.page, w.leadership)).toBeVisible();
  } finally {
    await avery.context.close();
    await nora.context.close();
  }
});

test('a public channel shows everyone read-only; rename and delete work from the details view and the sidebar menu', async ({ page, request }, info) => {
  const isPhone = info.project.name.includes('phone');
  const w = await seed(request);
  const project = await call(request, 'POST', '/conversations/channel', { workspaceId: w.workspace.id, name: 'Project Atlas' }, w.m.accessToken);

  await login(page, w.morgan);
  await openNavigation(page);
  await sidebarChannel(page, project).click();
  await expect(page).toHaveURL(new RegExp(`/channel/${project.id}`));

  // Everyone in the workspace, and no way to change the list, even as owner.
  let dialog = await openDetails(page);
  await expect(dialog.getByTestId('channel-visibility')).toHaveText('Public channel');
  await expect(dialog.getByTestId('channel-members').getByRole('listitem')).toHaveCount(3);
  await expect(dialog.getByRole('button', { name: 'Add people' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await expect(dialog.getByText('Everyone in the workspace is in a public channel.')).toBeVisible();
  await shot(page, `details-public-${info.project.name}.png`, (name) => info.outputPath(name));

  // Rename from the details view.
  await dialog.getByRole('button', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog');
  await rename.getByRole('textbox', { name: 'Channel name' }).fill('Atlas Launch');
  await rename.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByTestId('channel-details-trigger')).toContainText('atlas-launch');

  // The sidebar "..." menu still works, and now also opens the details.
  if (!isPhone) {
    await sidebarChannel(page, project).hover();
    await page.getByRole('button', { name: 'Manage #atlas-launch' }).click();
    await expect(page.getByRole('menuitem', { name: 'Rename channel' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete channel' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Channel details' }).click();
    dialog = page.getByTestId('channel-details');
    await expect(dialog.getByRole('heading', { name: 'atlas-launch' })).toBeVisible();
  } else {
    dialog = await openDetails(page);
  }

  // Delete from the details view: permanent, with the existing confirmation.
  await dialog.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByRole('heading', { name: 'Delete #atlas-launch?' })).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete channel' }).click();
  await expect(page).not.toHaveURL(new RegExp(`/channel/${project.id}`));
  await openNavigation(page);
  await expect(sidebarChannel(page, project)).toHaveCount(0);
  const after = await call(request, 'GET', `/workspaces/${w.workspace.id}`, undefined, w.m.accessToken);
  expect(after.channels.map((channel: any) => channel.id)).not.toContain(project.id);
});
