import { test, expect, type Page, type Locator } from '@playwright/test';
import { createRequire } from 'node:module';
import { call, login, seedWorkspace, webURL, apiURL, webHeaders, openNavigation, assertContained, clearCredentialFields } from './fixtures';

const sharp = createRequire(`${__dirname}/../../../packages/api/package.json`)('sharp');

// Synthetic artwork, generated in memory. No screenshots or fixture binaries in Git.
async function portrait(background: string, shirt: string, format: 'png' | 'webp') {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="${background}"/><path d="M80 512v-85q10-125 176-125t176 125v85" fill="${shirt}"/><rect x="220" y="280" width="72" height="80" rx="28" fill="#d99973"/><ellipse cx="256" cy="208" rx="108" ry="127" fill="#e9ad85"/><path d="M148 213V142q10-90 110-90t106 110v52l-37-92q-80 56-170 30z" fill="#3b2929"/><circle cx="218" cy="211" r="9" fill="#31292a"/><circle cx="294" cy="211" r="9" fill="#31292a"/><path d="M220 259q36 30 72 0" fill="none" stroke="#a54842" stroke-width="10" stroke-linecap="round"/></svg>`))[format]().toBuffer();
}

function watch(page: Page) {
  const events: { type: string; userId?: string }[] = [];
  page.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
    try {
      const event = JSON.parse(String(payload));
      events.push({ type: event.type, userId: event.userId });
    } catch { /* A non-JSON frame is not a profile update. */ }
  }));
  return events;
}

async function picture(image: Locator, source: string | null) {
  if (source === null) {
    await expect(image).toHaveCount(0);
  } else {
    await expect(image).toHaveAttribute('src', source);
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  }
}

async function choose(page: Page, buffer: Buffer, mimeType: string) {
  const response = page.waitForResponse(r => r.url() === `${apiURL}/auth/me` && r.request().method() === 'PATCH');
  await page.getByLabel('Choose profile picture').setInputFiles({ name: 'portrait', mimeType, buffer });
  const saved = await response;
  expect(saved.status()).toBe(200);
  const body = await saved.json();
  await expect(page.getByRole('status').filter({ hasText: 'Profile picture' })).toHaveText('Profile picture saved.');
  return body.user.avatar as string;
}

test('upload, replace and remove pictures across live settings, channel, DM, members and switcher', async ({ page, browser, request }, info) => {
  test.setTimeout(180_000);
  const f = await seedWorkspace(request);
  const channelMessage = await call(request, 'POST', `/messages/${f.channel.id}`, { content: 'Profile pictures make our conversations easier to recognise.' }, f.a.accessToken);
  await call(request, 'POST', `/messages/${f.channel.id}`, { content: 'I can see your new picture here without refreshing.' }, f.b.accessToken);
  const dmMessage = await call(request, 'POST', `/messages/${f.dm.id}`, { content: 'This earlier direct message should use my latest picture too.' }, f.a.accessToken);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const peerContext = await browser.newContext({ baseURL: webURL, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  try {
    const channel = await peerContext.newPage();
    const channelEvents = watch(channel);
    channel.on('pageerror', error => errors.push(error.message));
    await login(channel, f.bob);
    await expect(channel.getByText('Profile pictures make our conversations easier to recognise.', { exact: true })).toBeVisible();
    await expect.poll(() => channelEvents.some(e => e.type === 'auth_ok')).toBe(true);
    await login(page, f.alice);
    // Wait for automatic post-login routing before opening the mobile drawer,
    // since a route change deliberately closes it.
    await expect(page).toHaveURL(`${webURL}/#/channel/${f.channel.id}`);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await openNavigation(page);
    await page.getByRole('button', { name: /Alice Web Test$/ }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Choose profile picture')).toBeAttached();

    const original = await choose(page, await portrait('#b6dbeb', '#294c77', 'png'), 'image/png');
    await picture(page.locator('form[aria-label="Profile settings"] img').last(), original);
    await expect.poll(() => channelEvents.some(e => e.type === 'member_updated' && e.userId === f.a.user.id)).toBe(true);
    const channelAvatar = channel.locator(`[data-message-id="${channelMessage.id}"] img`).first();
    await picture(channelAvatar, original);
    const sidebarAvatar = channel.getByRole('button', { name: /^Alice Web Test,.*online$/ }).locator('img');
    await picture(sidebarAvatar, original);
    // The status dot remains a visible sibling rather than being clipped by the photo.
    await expect(channel.getByTestId(`online-indicator-${f.a.user.id}`)).toBeVisible();

    const dm = await peerContext.newPage();
    const members = await peerContext.newPage();
    const palette = await peerContext.newPage();
    for (const peer of [dm, members, palette]) peer.on('pageerror', error => errors.push(error.message));
    await dm.goto(`${webURL}/#/dm/${f.dm.id}`);
    await members.goto(`${webURL}/#/workspace/manage`);
    await palette.goto(`${webURL}/#/channel/${f.channel.id}`);
    await expect(palette.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await palette.keyboard.press('Control+k');
    await palette.getByRole('textbox', { name: 'Search TheChat' }).fill('@Alice');
    const dmAvatar = dm.locator(`[data-message-id="${dmMessage.id}"] img`).first();
    const memberAvatar = members.getByTestId(`member-row-${f.a.user.id}`).locator('img');
    const paletteAvatar = palette.getByTestId('palette-item').filter({ hasText: 'Alice Web Test' }).locator('img');
    for (const img of [dmAvatar, memberAvatar, paletteAvatar]) await picture(img, original);
    const isolatedWorkspace = await call(request, 'POST', '/workspaces/create', { name: 'Other workspace without Alice' }, f.b.accessToken);
    const switched = await peerContext.newPage();
    switched.on('pageerror', error => errors.push(error.message));
    await switched.goto(`${webURL}/#/channel/${f.channel.id}`);
    const switchedAvatar = switched.locator(`[data-message-id="${channelMessage.id}"] img`).first();
    await picture(switchedAvatar, original);
    await switched.getByRole('button', { name: f.workspace.name, exact: true }).click();
    await switched.getByRole('button', { name: isolatedWorkspace.name, exact: true }).click();
    await expect(switched.getByRole('button', { name: isolatedWorkspace.name, exact: true })).toBeVisible();
    await expect(switched).toHaveURL(`${webURL}/#/channel/${f.channel.id}`);
    await picture(switchedAvatar, original);

    // Keep this popup open during both updates: no subsequent editor input.
    await channel.getByRole('textbox', { name: 'Message', exact: true }).fill('@Alice');
    const mentionAvatar = channel.getByRole('button', { name: 'Alice Web Test', exact: true }).locator('img');
    await picture(mentionAvatar, original);

    const documents = [channel, dm, members, palette, switched];
    const before = await Promise.all(documents.map(peer => peer.evaluate(() => performance.timeOrigin)));
    const replacement = await choose(page, await portrait('#d3c4ee', '#6b3e8e', 'webp'), 'image/webp');
    expect(replacement).not.toBe(original);
    for (const img of [channelAvatar, sidebarAvatar, dmAvatar, memberAvatar, paletteAvatar, switchedAvatar, mentionAvatar]) await picture(img, replacement);
    await page.getByRole('button', { name: 'Remove picture', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Profile picture' })).toHaveText('Profile picture removed.');
    for (const img of [channelAvatar, sidebarAvatar, dmAvatar, memberAvatar, paletteAvatar, switchedAvatar, mentionAvatar]) await picture(img, null);
    expect(await Promise.all(documents.map(peer => peer.evaluate(() => performance.timeOrigin)))).toEqual(before);
    const me = await page.context().request.get(`${apiURL}/auth/me`, { headers: webHeaders });
    expect((await me.json()).user.avatar).toBeNull();

    const final = await choose(page, await portrait('#b6dbeb', '#294c77', 'png'), 'image/png');
    await picture(channelAvatar, final);
    await page.reload();
    await picture(page.locator('form[aria-label="Profile settings"] img').last(), final);
    await assertContained(page, 'form[aria-label="Profile settings"]');
    await expect.poll(() => page.locator('form img').last().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(256);
    await channel.getByRole('textbox', { name: 'Message', exact: true }).press('Escape');
    await channel.getByRole('textbox', { name: 'Message', exact: true }).press('Control+a');
    await channel.getByRole('textbox', { name: 'Message', exact: true }).press('Backspace');
    await page.screenshot({ path: info.outputPath('profile-settings.png') });
    await channel.screenshot({ path: info.outputPath('profile-channel.png') });
    if (info.project.name.includes('phone')) {
      const label = page.getByLabel('Choose profile picture').locator('..');
      const remove = page.getByRole('button', { name: 'Remove picture', exact: true });
      expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    // Invalid source selection does not replace the saved picture.
    await page.getByLabel('Choose profile picture').setInputFiles({ name: 'unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await expect(page.getByRole('alert')).toHaveText('Choose a PNG, JPEG, or WebP image');
    await picture(page.locator('form img').last(), final);
    expect(errors).toEqual([]);
  } finally {
    await clearCredentialFields(page);
    await peerContext.close();
  }
});
