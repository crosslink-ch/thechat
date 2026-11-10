import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { apiURL, call, clearCredentialFields, identity, login, openNavigation, webURL } from './fixtures';

test.afterEach(async ({ page }) => clearCredentialFields(page));

/** PR screenshots go here when set; otherwise into the test's output folder. */
async function shot(page: Page, name: string, outputPath: (name: string) => string) {
  const dir = process.env.THECHAT_PRIVATE_CHANNEL_SCREENSHOTS;
  if (dir) mkdirSync(dir, { recursive: true });
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  await page.screenshot({ path: dir ? join(dir, name) : outputPath(name) });
}

async function seed(request: Parameters<typeof call>[0]) {
  const morgan = identity('Morgan Owner');
  const avery = identity('Avery Picked');
  const nora = identity('Nora Outside');
  const m = await call(request, 'POST', '/auth/register', morgan);
  const a = await call(request, 'POST', '/auth/register', avery);
  const n = await call(request, 'POST', '/auth/register', nora);
  const workspace = await call(request, 'POST', '/workspaces/create', { name: `Acme ${randomUUID().slice(0, 6)}` }, m.accessToken);
  for (const [person, session] of [[avery, a], [nora, n]] as const) {
    const invite = await call(request, 'POST', '/invites/create', { workspaceId: workspace.id, email: person.email }, m.accessToken);
    await call(request, 'POST', '/invites/accept', { inviteId: invite.id }, session.accessToken);
  }
  const detail = await call(request, 'GET', `/workspaces/${workspace.id}`, undefined, m.accessToken);
  return { morgan, avery, nora, m, a, n, workspace, general: detail.channels[0] };
}

async function peer(browser: Browser, viewport: { width: number; height: number }, person: ReturnType<typeof identity>) {
  const context = await browser.newContext({ baseURL: webURL, ignoreHTTPSErrors: true, viewport });
  const page = await context.newPage();
  await login(page, person);
  return { context, page };
}

/** The channel's own sidebar row, not the "Manage #name" menu next to it. */
const sidebarChannel = (target: Page, name: string) =>
  target.locator('button[data-channel-id]').filter({ hasText: new RegExp(`^#?${name}$`) });

/**
 * On a phone the sidebar is a drawer. A single check can land in the middle of
 * its transition, so keep trying until the sidebar is really there.
 */
async function showSidebar(target: Page) {
  const search = target.getByTestId('sidebar-search');
  await expect(async () => {
    const toggle = target.getByRole('button', { name: 'Open navigation', exact: true });
    if (!(await search.isVisible()) && (await toggle.isVisible())) await toggle.click();
    await expect(search).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

async function hideSidebar(target: Page, isPhone: boolean) {
  if (!isPhone) return;
  const search = target.getByTestId('sidebar-search');
  await expect(async () => {
    if (await search.isVisible()) await target.keyboard.press('Escape');
    await expect(search).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
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

test('an owner creates a private channel; picked members get it, the rest of the workspace never sees it', async ({ page, request, browser }, info) => {
  const isPhone = info.project.name.includes('phone');
  const viewport = page.viewportSize()!;
  const w = await seed(request);

  // Avery and Nora are signed in and connected before the channel exists.
  const avery = await peer(browser, viewport, w.avery);
  const nora = await peer(browser, viewport, w.nora);
  try {
    await expect(avery.page).toHaveURL(new RegExp(`/channel/${w.general.id}`));
    await expect(nora.page).toHaveURL(new RegExp(`/channel/${w.general.id}`));

    // Morgan creates #leadership as private and picks Avery, not Nora.
    await login(page, w.morgan);
    await expect(page).toHaveURL(new RegExp(`/channel/${w.general.id}`));
    await openNavigation(page);
    await page.getByRole('button', { name: 'Create channel', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Channel name' }).fill('Leadership');
    // Public is the default and offers no member list.
    await expect(dialog.getByRole('radio', { name: /^Public/ })).toBeChecked();
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await dialog.getByRole('radio', { name: /^Private/ }).check();
    await expect(dialog.getByRole('checkbox', { name: 'Morgan Owner (you)' })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Morgan Owner (you)' })).toBeDisabled();
    await dialog.getByRole('checkbox', { name: 'Include Avery Picked' }).check();
    await expect(dialog.getByRole('checkbox', { name: 'Include Nora Outside' })).not.toBeChecked();
    await expect(dialog.getByText('2 selected')).toBeVisible();
    await shot(page, `private-create-${info.project.name}.png`, (name) => info.outputPath(name));
    await dialog.getByRole('button', { name: 'Create channel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).not.toHaveURL(new RegExp(`/channel/${w.general.id}`));
    const leadershipId = /\/channel\/([0-9a-f-]{36})/.exec(page.url())![1];

    // Morgan posts in it, then in #general: the public message is the barrier
    // that proves Nora's realtime connection was delivering all along.
    const secret = `Q3 reorg plan ${randomUUID().slice(0, 8)}`;
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(secret);
    await page.getByTitle('Send message', { exact: true }).click();
    await expect(page.locator('[data-message-id]').filter({ hasText: secret })).toBeVisible();
    const barrier = `All-hands moved to Friday ${randomUUID().slice(0, 8)}`;
    await call(request, 'POST', `/messages/${w.general.id}`, { content: barrier }, w.m.accessToken);

    // Avery got the channel live, with a lock, and can read it.
    await openNavigation(avery.page);
    const averyChannel = sidebarChannel(avery.page, 'leadership');
    await expect(averyChannel).toBeVisible();
    await expect(averyChannel.getByRole('img', { name: 'Private channel' })).toBeVisible();
    await expect(sidebarChannel(avery.page, 'general').getByRole('img', { name: 'Private channel' })).toHaveCount(0);
    await averyChannel.click();
    await expect(avery.page).toHaveURL(new RegExp(`/channel/${leadershipId}`));
    await expect(avery.page.locator('[data-message-id]').filter({ hasText: secret })).toBeVisible();
    await openNavigation(avery.page);
    await shot(avery.page, `private-member-${info.project.name}.png`, (name) => info.outputPath(name));
    if (isPhone) await avery.page.keyboard.press('Escape');
    const averyHits = await searchFor(avery.page, isPhone, `?${secret}`);
    // Hits are matched by their accessible name: the visible text is split by highlight marks.
    await expect(averyHits.getByRole('button', { name: `Message from Morgan Owner in #leadership: ${secret}` })).toBeVisible();

    // Nora received the public message, and nothing about #leadership.
    await expect(nora.page.locator('[data-message-id]').filter({ hasText: barrier })).toBeVisible();
    await openNavigation(nora.page);
    await expect(sidebarChannel(nora.page, 'general')).toBeVisible();
    await expect(sidebarChannel(nora.page, 'leadership')).toHaveCount(0);
    await expect(nora.page.getByRole('img', { name: 'Private channel' })).toHaveCount(0);
    await shot(nora.page, `private-non-member-${info.project.name}.png`, (name) => info.outputPath(name));
    if (isPhone) await nora.page.keyboard.press('Escape');

    // Not in the quick switcher, not in message search.
    let panel = await searchFor(nora.page, isPhone, '#leadership');
    await expect(panel.getByRole('button', { name: /^general, channel/ })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /^leadership, channel/ })).toHaveCount(0);
    await panel.getByRole('textbox', { name: 'Search TheChat' }).fill('#general');
    await expect(panel.getByRole('button', { name: /^general, channel/ })).toBeVisible();
    await panel.getByRole('textbox', { name: 'Search TheChat' }).fill(`?${barrier}`);
    await expect(panel.getByRole('button', { name: `Message from Morgan Owner in #general: ${barrier}` })).toBeVisible();
    await panel.getByRole('textbox', { name: 'Search TheChat' }).fill(`?${secret}`);
    await expect(panel.getByText(/No messages/i)).toBeVisible();
    await expect(panel.getByRole('button', { name: /^Message from/ })).toHaveCount(0);
    await nora.page.keyboard.press('Escape');

    // A guessed link bounces to a channel she can see; reload changes nothing.
    await nora.page.goto(`${webURL}/#/channel/${leadershipId}`);
    await expect(nora.page).toHaveURL(new RegExp(`/channel/${w.general.id}`));
    await expect(nora.page.getByText(secret)).toHaveCount(0);
    await nora.page.reload();
    // The drawer toggle exists only once the app has rendered again.
    await expect(nora.page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await openNavigation(nora.page);
    await expect(sidebarChannel(nora.page, 'general')).toBeVisible();
    await expect(sidebarChannel(nora.page, 'leadership')).toHaveCount(0);

    // Direct API reads and writes are refused for Nora and work for Avery.
    const asNora = (method: string, path: string, data?: unknown) =>
      request.fetch(`${apiURL}${path}`, {
        method, ...(data === undefined ? {} : { data }),
        headers: { authorization: `Bearer ${w.n.accessToken}` },
      });
    expect((await asNora('GET', `/conversations/detail/${leadershipId}`)).status()).toBe(403);
    expect((await asNora('GET', `/messages/${leadershipId}`)).status()).toBe(403);
    expect((await asNora('POST', `/messages/${leadershipId}`, { content: 'let me in' })).status()).toBe(403);
    expect((await asNora('PATCH', `/conversations/channel/${leadershipId}`, { name: 'mine' })).status()).toBe(403);
    expect((await asNora('DELETE', `/conversations/channel/${leadershipId}`)).status()).toBe(403);
    const forAvery = await call(request, 'GET', `/messages/${leadershipId}`, undefined, w.a.accessToken);
    expect(forAvery.map((message: any) => message.content)).toEqual([secret]);
    // Channels that existed before stay public.
    const forNora = await call(request, 'GET', `/workspaces/${w.workspace.id}`, undefined, w.n.accessToken);
    expect(forNora.channels).toEqual([expect.objectContaining({ id: w.general.id, isPrivate: false })]);
  } finally {
    await avery.context.close();
    await nora.context.close();
  }
});

test('members manage a private channel: details, add, remove, leave, visibility', async ({ page, request, browser }, info) => {
  const isPhone = info.project.name.includes('phone');
  const viewport = page.viewportSize()!;
  const w = await seed(request);
  // Avery, a regular workspace member, creates the channel with Nora. Morgan owns the workspace and is left out.
  const room = await call(request, 'POST', '/conversations/channel', {
    workspaceId: w.workspace.id, name: 'Offsite', isPrivate: true, memberIds: [w.n.user.id],
  }, w.a.accessToken);
  const secret = `Venue is booked ${randomUUID().slice(0, 8)}`;
  await call(request, 'POST', `/messages/${room.id}`, { content: secret }, w.a.accessToken);
  const openDetails = async (target: Page) => {
    await target.getByRole('button', { name: /^Channel details:/ }).click();
    const dialog = target.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'offsite' })).toBeVisible();
    return dialog;
  };
  const closeDetails = async (target: Page) => {
    await target.getByRole('button', { name: 'Close channel details' }).click();
    await expect(target.getByRole('dialog')).toHaveCount(0);
  };

  const morgan = await peer(browser, viewport, w.morgan);
  const nora = await peer(browser, viewport, w.nora);
  try {
    // The workspace owner sees nothing of it.
    await showSidebar(morgan.page);
    await expect(sidebarChannel(morgan.page, 'general')).toBeVisible();
    await expect(sidebarChannel(morgan.page, 'offsite')).toHaveCount(0);
    await hideSidebar(morgan.page, isPhone);

    // Avery opens the channel: the header carries the lock and the member count.
    await login(page, w.avery);
    await showSidebar(page);
    await sidebarChannel(page, 'offsite').click();
    await expect(page).toHaveURL(new RegExp(`/channel/${room.id}`));
    await expect(page.getByRole('button', { name: 'Channel details: private channel offsite, 2 members' })).toBeVisible();

    // As channel admin (not a workspace admin) Avery gets the full set of controls.
    let dialog = await openDetails(page);
    const membersList = dialog.getByRole('region', { name: 'Members' });
    await expect(membersList.getByText('Avery Picked (you)')).toBeVisible();
    await expect(membersList.getByText('Channel admin')).toBeVisible();
    await expect(membersList.getByText('Nora Outside')).toBeVisible();
    await expect(membersList.getByText('Morgan Owner')).toHaveCount(0);
    for (const control of ['Rename', 'Make public', 'Leave channel', 'Delete channel']) {
      await expect(dialog.getByRole('button', { name: control, exact: true })).toBeVisible();
    }
    await shot(page, `private-details-${info.project.name}.png`, (name) => info.outputPath(name));

    // Avery adds Morgan, who gets the channel live with its earlier message.
    await dialog.getByRole('button', { name: 'Add people' }).click();
    await dialog.getByRole('checkbox', { name: 'Add Morgan Owner' }).check();
    await shot(page, `private-add-people-${info.project.name}.png`, (name) => info.outputPath(name));
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(membersList.getByText('Morgan Owner')).toBeVisible();
    await closeDetails(page);
    await expect(page.getByRole('button', { name: 'Channel details: private channel offsite, 3 members' })).toBeVisible();

    await showSidebar(morgan.page);
    const morganChannel = sidebarChannel(morgan.page, 'offsite');
    await expect(morganChannel).toBeVisible();
    await expect(morganChannel.getByRole('img', { name: 'Private channel' })).toBeVisible();
    await morganChannel.click();
    await expect(morgan.page.locator('[data-message-id]').filter({ hasText: secret })).toBeVisible();

    // Nora is an ordinary member: she can add people and leave, nothing else.
    await showSidebar(nora.page);
    await sidebarChannel(nora.page, 'offsite').click();
    await expect(nora.page).toHaveURL(new RegExp(`/channel/${room.id}`));
    dialog = await openDetails(nora.page);
    await expect(dialog.getByRole('button', { name: 'Add people' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Leave channel', exact: true })).toBeVisible();
    for (const control of ['Rename', 'Make public', 'Delete channel']) {
      await expect(dialog.getByRole('button', { name: control, exact: true })).toHaveCount(0);
    }
    await expect(dialog.getByRole('button', { name: /from channel$/ })).toHaveCount(0);
    await closeDetails(nora.page);

    // Avery removes Morgan again.
    dialog = await openDetails(page);
    await dialog.getByRole('button', { name: 'Remove Morgan Owner from channel' }).click();
    await expect(dialog.getByRole('region', { name: 'Members' }).getByText('Morgan Owner')).toHaveCount(0);
    await closeDetails(page);
    // Morgan was reading it: the channel disappears and they are moved to one they can see.
    await expect(morgan.page).toHaveURL(new RegExp(`/channel/${w.general.id}`));
    await showSidebar(morgan.page);
    await expect(sidebarChannel(morgan.page, 'offsite')).toHaveCount(0);
    await hideSidebar(morgan.page, isPhone);
    const asMorgan = await request.fetch(`${apiURL}/messages/${room.id}`, { headers: { authorization: `Bearer ${w.m.accessToken}` } });
    expect(asMorgan.status()).toBe(403);

    // Nora leaves; she is moved out and the channel is gone for her.
    dialog = await openDetails(nora.page);
    await dialog.getByRole('button', { name: 'Leave channel', exact: true }).click();
    await expect(dialog.getByText(/Someone in it can add you back/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Leave channel', exact: true }).click();
    await expect(nora.page).toHaveURL(new RegExp(`/channel/${w.general.id}`));
    await showSidebar(nora.page);
    await expect(sidebarChannel(nora.page, 'offsite')).toHaveCount(0);
    await hideSidebar(nora.page, isPhone);
    await expect(page.getByRole('button', { name: 'Channel details: private channel offsite, 1 member' })).toBeVisible();

    // Avery makes it public after a confirmation: everyone gets it, without a lock, with its history.
    dialog = await openDetails(page);
    await dialog.getByRole('button', { name: 'Make public', exact: true }).click();
    await expect(dialog.getByText(/Everyone in the workspace will be added/)).toBeVisible();
    await shot(page, `private-make-public-${info.project.name}.png`, (name) => info.outputPath(name));
    await dialog.getByRole('button', { name: 'Make public', exact: true }).click();
    await expect(dialog.getByText('Public channel. Everyone in the workspace can see and open it.')).toBeVisible();
    // It is an ordinary public channel now: Avery, a regular member, no longer manages it.
    await expect(dialog.getByRole('button', { name: 'Rename', exact: true })).toHaveCount(0);
    await closeDetails(page);
    await expect(page.getByRole('button', { name: 'Channel details: offsite, 3 members' })).toBeVisible();

    await showSidebar(nora.page);
    const noraChannel = sidebarChannel(nora.page, 'offsite');
    await expect(noraChannel).toBeVisible();
    await expect(noraChannel.getByRole('img', { name: 'Private channel' })).toHaveCount(0);
    await noraChannel.click();
    await expect(nora.page.locator('[data-message-id]').filter({ hasText: secret })).toBeVisible();
  } finally {
    await morgan.context.close();
    await nora.context.close();
  }
});
