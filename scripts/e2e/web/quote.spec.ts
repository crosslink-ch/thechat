import { test, expect, type Page } from '@playwright/test';
import { webURL, seedWorkspace, login, call, assertContained, clearCredentialFields } from './fixtures';
test.afterEach(async ({ page }) => clearCredentialFields(page));

const SOURCE = 'Direction matters. A rule like group:eng → tag:vm:22 lets users start connections to the VM. ' +
  'Return traffic for those connections is allowed automatically (stateful), but the VM cannot initiate new connections toward the user.';
const SNIPPET = 'A rule like group:eng → tag:vm:22 lets users start connections to the VM.';
const REPLY = 'How does the OS tell an initial connection apart from return traffic?';

/**
 * Select `snippet` inside one message body: a real mouse drag on desktop, and the platform
 * selection API on touch profiles, where Playwright has no long-press selection gesture.
 */
async function selectInMessage(page: Page, messageId: string, snippet: string, drag: boolean) {
  const body = page.locator(`[data-quote-source="${messageId}"]`);
  await expect(body).toContainText(snippet);
  const points = await body.evaluate((element, { text, select }) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const start = node.data.indexOf(text);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + text.length);
      if (select) {
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const rects = Array.from(range.getClientRects());
      const first = rects[0];
      const last = rects[rects.length - 1];
      return {
        from: { x: first.left + 1, y: first.top + first.height / 2 },
        to: { x: last.right - 1, y: last.top + last.height / 2 },
      };
    }
    throw new Error('snippet is not rendered as one text node');
  }, { text: snippet, select: !drag });
  if (!drag) return;
  await page.mouse.move(points.from.x, points.from.y);
  await page.mouse.down();
  await page.mouse.move(points.to.x, points.to.y, { steps: 12 });
  await page.mouse.up();
}

/** Wait for entry animations so screenshots show the final state. */
async function settled(locator: import('@playwright/test').Locator) {
  await locator.evaluate(element =>
    Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
}

test('reply to selected text: composer quote, sent quote card, full quote dialog and realtime delivery', async ({ page, request, browser }, info) => {
  const desktop = info.project.name === 'chromium-desktop';
  const f = await seedWorkspace(request);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const content of ['Morning! Quick question about the VM access setup.', 'Sure, here is how the policy works:']) {
    await call(request, 'POST', `/messages/${f.channel.id}`, { content }, f.b.accessToken);
  }
  const source = await call(request, 'POST', `/messages/${f.channel.id}`, { content: SOURCE }, f.b.accessToken);

  await login(page, f.alice);
  await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
  const peerContext = await browser.newContext({ baseURL: webURL, viewport: { width: 1280, height: 900 } });
  try {
    const peer = await peerContext.newPage();
    await login(peer, f.bob);
    await expect(peer).toHaveURL(new RegExp(`/channel/${f.channel.id}`));

    await selectInMessage(page, source.id, SNIPPET, desktop);
    const reply = page.getByTestId('selection-reply');
    await expect(reply).toBeVisible();
    await expect(reply).toHaveText('Reply');
    await assertContained(page, '[data-testid="selection-reply"]');
    await settled(reply);
    // With room above the selection, the button sits above it and leaves the selected text uncovered.
    const [buttonBox, selectionTop] = await Promise.all([
      reply.boundingBox(),
      page.evaluate(() => window.getSelection()!.getRangeAt(0).getBoundingClientRect().top),
    ]);
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(selectionTop);
    if (desktop) await page.screenshot({ path: info.outputPath('1-reply-button.png') });

    await reply.click();
    await expect(reply).toBeHidden();
    const chip = page.getByTestId('quote-draft-card');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('A rule like group:eng');
    // The composer keeps focus, so the reply can be typed straight away.
    await expect(page.locator('[contenteditable=true]')).toBeFocused();
    await page.keyboard.type(REPLY);
    if (desktop) await page.locator('.chat-composer').screenshot({ path: info.outputPath('2-composer-quote.png') });
    await assertContained(page, '[data-testid="quote-draft-card"]');

    await page.getByTitle('Send message', { exact: true }).click();
    await expect(chip).toBeHidden();

    await expect.poll(async () => {
      const messages = await call(request, 'GET', `/messages/${f.channel.id}`, undefined, f.b.accessToken);
      return messages.find((message: any) => message.content === REPLY)?.quote ?? null;
    }).toEqual({ text: SNIPPET, messageId: source.id });

    const sentCard = page.getByTestId('message-quote');
    await expect(sentCard).toHaveCount(1);
    await expect(sentCard).toContainText('A rule like group:eng');
    const peerCard = peer.getByTestId('message-quote');
    await expect(peerCard).toHaveCount(1);
    await expect(peerCard).toContainText('A rule like group:eng');

    await page.reload();
    await expect(page.getByTestId('message-quote')).toHaveCount(1);
    if (desktop) {
      const sentMessage = page.locator('[data-message-id]').filter({ hasText: REPLY });
      await sentMessage.screenshot({ path: info.outputPath('3-sent-quote.png') });
    }

    await page.getByTestId('message-quote').click();
    const dialog = page.getByRole('dialog', { name: 'Quote' });
    await expect(dialog).toBeVisible();
    await settled(dialog);
    await expect(dialog.locator('blockquote')).toHaveText(SNIPPET);
    await assertContained(page, '[role="dialog"]');
    if (desktop) await page.screenshot({ path: info.outputPath('4-quote-dialog.png') });
    await dialog.getByRole('button', { name: 'Close quote' }).click();
    await expect(dialog).toBeHidden();

    expect(errors).toEqual([]);
  } finally {
    await peerContext.close();
  }
});

test('removing a picked quote sends a plain message', async ({ page, request }, info) => {
  const f = await seedWorkspace(request);
  const source = await call(request, 'POST', `/messages/${f.channel.id}`, { content: SOURCE }, f.b.accessToken);
  await login(page, f.alice);
  await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));

  await selectInMessage(page, source.id, SNIPPET, info.project.name === 'chromium-desktop');
  await page.getByTestId('selection-reply').click();
  await expect(page.getByTestId('quote-draft-card')).toBeVisible();
  await page.getByRole('button', { name: 'Remove quote' }).click();
  await expect(page.getByTestId('quote-draft-card')).toBeHidden();

  const plain = `Plain follow-up ${info.project.name}`;
  await page.locator('[contenteditable=true]').fill(plain);
  await page.getByTitle('Send message', { exact: true }).click();
  await expect.poll(async () => {
    const messages = await call(request, 'GET', `/messages/${f.channel.id}`, undefined, f.a.accessToken);
    const sent = messages.find((message: any) => message.content === plain);
    return sent ? { quote: sent.quote } : null;
  }).toEqual({ quote: null });
  await expect(page.getByTestId('message-quote')).toHaveCount(0);
});
