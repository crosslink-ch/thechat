import { test, expect, type Locator, type Page } from '@playwright/test';
import { seedWorkspace, login, call, openNavigation, assertContained, clearCredentialFields } from './fixtures';

test.afterEach(async ({ page }) => clearCredentialFields(page));

async function geometry(scroller: Locator) {
  return scroller.evaluate(element => {
    const r = element.getBoundingClientRect();
    return {
      top: element.scrollTop,
      height: element.clientHeight,
      contentHeight: element.scrollHeight,
      gap: element.scrollHeight - element.clientHeight - element.scrollTop,
      bottom: r.bottom,
      viewportHeight: innerHeight,
    };
  });
}

async function expectBottom(page: Page, scroller: Locator, newest: string) {
  await expect.poll(async () => (await geometry(scroller)).gap).toBeLessThanOrEqual(2);
  await expect(scroller.getByText(newest, { exact: true })).toBeInViewport();
  await assertContained(page, '[contenteditable=true]');
  await assertContained(page, '[title="Send message"]');
}

test('populated Hermes DM keeps history and composer inside the mobile layout', async ({ page, request }, info) => {
  const f = await seedWorkspace(request);
  const bot = await call(request, 'POST', '/bots/create', { name: 'Scroll test bot', kind: 'hermes', workspaceId: f.workspace.id }, f.a.accessToken);
  const dm = await call(request, 'POST', '/conversations/dm', { workspaceId: f.workspace.id, otherUserId: bot.userId }, f.a.accessToken);
  for (let index = 0; index < 25; index++) {
    await call(request, 'POST', `/messages/${dm.id}`, {
      content: `Bot history ${index}\n\nA previous response with enough text to occupy more than one line on a phone.`,
    }, bot.apiKey);
  }
  const newest = 'Newest bot response';
  await call(request, 'POST', `/messages/${dm.id}`, { content: newest }, bot.apiKey);
  await login(page, f.alice);
  await page.goto(`/#/dm/${dm.id}`);
  const scroller = page.getByTestId('hermes-dm-chat-scroll');
  await expect(scroller.getByText(newest, { exact: true })).toBeAttached();
  await expectBottom(page, scroller, newest);
  expect((await geometry(scroller)).contentHeight).toBeGreaterThan((await geometry(scroller)).height + 300);
  const taskToggle = page.getByRole('button', { name: 'Open tasks and activity', exact: true });
  if (await taskToggle.isVisible()) {
    await taskToggle.click();
    await page.getByRole('button', { name: 'Close tasks and activity', exact: true }).click();
    await expectBottom(page, scroller, newest);
  }
  await page.screenshot({ path: info.outputPath('hermes-dm-open.png'), fullPage: true });
});

test('populated DM opens at newest messages, scrolls, and reopens at bottom', async ({ page, request, browserName }, info) => {
  const f = await seedWorkspace(request);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // More than one history page, with enough height to expose the mobile flex
  // minimum. Alternate senders so message merging cannot hide the regression.
  for (let index = 0; index < 65; index++) {
    await call(request, 'POST', `/messages/${f.dm.id}`, {
      content: `History ${index}: a previous message in this private conversation.\n\n` +
        (index % 10 === 0 ? '```sh\nprintf "a deliberately long command that stays in its own horizontal code scroller"\n```' : 'Some additional text to make this a realistic conversation.'),
    }, index % 2 ? f.b.accessToken : f.a.accessToken);
  }
  const newest = 'Newest DM message';
  await call(request, 'POST', `/messages/${f.dm.id}`, { content: newest }, f.b.accessToken);
  await login(page, f.alice);
  await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
  await openNavigation(page);
  await page.getByText('Bob Web Test', { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dm/${f.dm.id}`));
  await expect(page.getByRole('dialog', { name: 'Workspace navigation', exact: true })).toHaveCount(0);
  const scroller = page.getByTestId('channel-chat-scroll');
  await expect(scroller.getByText(newest, { exact: true })).toBeAttached();

  const opening = await geometry(scroller);
  await info.attach('opening-geometry', { body: JSON.stringify(opening), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('dm-open.png'), fullPage: true });
  // A zero gap alone is not proof of being at bottom: the broken viewport is
  // as tall as all history and therefore has no scrollable overflow at all.
  expect(opening.height).toBeGreaterThan(100);
  expect(opening.bottom).toBeLessThanOrEqual(opening.viewportHeight);
  expect(opening.contentHeight).toBeGreaterThan(opening.height + 300);
  await expectBottom(page, scroller, newest);

  const box = (await scroller.boundingBox())!;
  if (browserName === 'chromium' && info.project.use.isMobile) {
    const session = await page.context().newCDPSession(page);
    // Dispatch a real finger drag on the message viewport's padding, away
    // from nested code-block scroll areas and message action buttons.
    const x = Math.round(box.x + 8);
    const y = Math.round(box.y + 60);
    const point = (offset: number) => [{ x, y: y + offset, id: 1, radiusX: 1, radiusY: 1, force: 1 }];
    try {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(0) });
      for (let step = 1; step <= 14; step++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(step * 25) });
        await page.waitForTimeout(20); // finger movement duration, not an app-readiness delay
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await session.detach();
    }
  } else if (browserName === 'webkit' && info.project.use.isMobile) {
    // Playwright has no mobile-WebKit wheel or swipe API. Geometry and actual
    // scroll events are covered here; native touch is covered by Chromium.
    await scroller.evaluate(element => element.scrollBy(0, -350));
  } else {
    await page.mouse.move(box.x + 8, box.y + box.height / 2);
    await page.mouse.wheel(0, -350);
  }
  // Auto-pagination can prepend history and INCREASE scrollTop. The bottom
  // gap and visible-row anchor describe the user's position across prepends.
  await expect.poll(async () => (await geometry(scroller)).gap).toBeGreaterThan(100);
  await scroller.evaluate(element => new Promise<void>((resolve, reject) => {
    let previous = `${element.scrollTop}:${element.scrollHeight}:${element.clientHeight}`;
    let stableFrames = 0;
    const started = performance.now();
    const check = () => {
      const current = `${element.scrollTop}:${element.scrollHeight}:${element.clientHeight}`;
      stableFrames = current === previous ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames >= 8) resolve();
      else if (performance.now() - started > 5_000) reject(new Error('Scroll did not settle after the gesture'));
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }));
  const anchor = await scroller.locator('[data-message-id]').evaluateAll(rows => {
    const row = rows.find(element => {
      const r = element.getBoundingClientRect();
      const parent = element.parentElement!.getBoundingClientRect();
      return r.top >= parent.top && r.bottom <= parent.bottom;
    })!;
    return { id: row.getAttribute('data-message-id'), top: row.getBoundingClientRect().top };
  });
  const received = 'New message while reading older history';
  await call(request, 'POST', `/messages/${f.dm.id}`, { content: received }, f.b.accessToken);
  await expect(scroller.getByText(received, { exact: true })).toBeAttached();
  const anchorRow = scroller.locator(`[data-message-id="${anchor.id}"]`);
  await expect.poll(async () => Math.abs((await anchorRow.boundingBox())!.y - anchor.top)).toBeLessThan(3);

  // Returning via the actual drawer must close its modal scroll lock and reset
  // this conversation to the newest message, including the cached history path.
  await openNavigation(page);
  await page.locator(`[data-channel-id="${f.channel.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
  await openNavigation(page);
  await page.getByText('Bob Web Test', { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/dm/${f.dm.id}`));
  await expectBottom(page, scroller, received);
  await page.reload();
  await expectBottom(page, scroller, received);

  // A shorter visual viewport and both sides of the DM layout breakpoint must
  // retain a real bounded message viewport and a reachable composer.
  for (const viewport of [{ width: 320, height: 480 }, { width: 1279, height: 800 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await expectBottom(page, scroller, received);
    await expect.poll(async () => (await geometry(scroller)).height).toBeGreaterThan(100);
    await page.screenshot({ path: info.outputPath(`dm-${viewport.width}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});
