import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { apiURL, webHeaders, login, seedWorkspace, assertContained, clearCredentialFields } from './fixtures';

// Chromium supplies a synthetic microphone device. getUserMedia and MediaRecorder
// remain browser implementations: no Tauri bridge, auth-store injection, or API mocks.
// WebKit has no equivalent Chromium fake-device flag; do not claim its mic coverage.
test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});
test.skip(({ browserName }) => browserName !== 'chromium', 'Synthetic microphone acceptance requires Chromium fake-device support');
test.afterEach(async ({ page }) => clearCredentialFields(page));

type VoiceProbeWindow = Window & { __voiceE2ETracks: MediaStreamTrack[] };
async function tracks(page: Page) {
  return page.evaluate(() => (window as unknown as VoiceProbeWindow).__voiceE2ETracks.map(track => ({
    kind: track.kind, state: track.readyState,
  })));
}
async function assertReleased(page: Page, count: number) {
  await expect.poll(async () => {
    const observed = await tracks(page);
    return observed.length >= count && observed.every(track => track.state === 'ended');
  }, { message: 'All real microphone tracks must be ended' }).toBe(true);
}
async function playRealAudio(page: Page, selector: string, playLabel: string) {
  const audio = page.locator(selector);
  await expect(audio).toBeAttached();
  await page.getByRole('button', { name: playLabel, exact: true }).click();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime), {
    message: 'The real browser decoder must advance playback',
  }).toBeGreaterThan(0.25);
  const observed = await audio.evaluate((element: HTMLAudioElement) => ({
    currentTime: element.currentTime, readyState: element.readyState,
    error: element.error?.code ?? null,
  }));
  expect(observed.error).toBeNull();
  await audio.evaluate((element: HTMLAudioElement) => element.pause());
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => Number.isFinite(element.duration) && element.duration > 0), { message: 'Actual recorded media must have usable finite duration' }).toBe(true);
  const seek = page.getByRole('slider', { name: playLabel.replace(/^Play /, 'Seek '), exact: true });
  await expect(seek).toBeEnabled();
  await seek.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0);
  return observed;
}

test('real web voice: cancel, preview, channel and DM send, reload, playback and byte-exact download', async ({ page, request }, info) => {
  test.setTimeout(150_000);
  await page.context().grantPermissions(['microphone']);
  const f = await seedWorkspace(request);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // Observation only: forward to native getUserMedia and retain references to the
  // actual tracks so cancellation/stop cleanup cannot be faked by a UI assertion.
  await page.addInitScript(() => {
    const target = window as unknown as VoiceProbeWindow;
    target.__voiceE2ETracks = [];
    const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await nativeGetUserMedia(constraints);
      target.__voiceE2ETracks.push(...stream.getTracks());
      return stream;
    };
  });
  const traffic = { reserves: 0, puts: 0, completes: 0, authorizations: 0 };
  const apiRequests: Array<{ method: string; path: string; bearer: boolean; web: boolean }> = [];
  page.on('request', req => {
    const url = new URL(req.url());
    if (req.method() === 'PUT') traffic.puts += 1;
    if (url.origin !== new URL(apiURL).origin) return;
    const path = url.pathname;
    if (req.method() === 'POST' && path === '/attachments') traffic.reserves += 1;
    if (req.method() === 'POST' && /^\/attachments\/[^/]+\/complete$/.test(path)) traffic.completes += 1;
    if (req.method() === 'GET' && /^\/attachments\/[^/]+\/download$/.test(path)) traffic.authorizations += 1;
    if (path.startsWith('/attachments') || (path.startsWith('/messages') && req.method() === 'POST')) {
      apiRequests.push({ method: req.method(), path, bearer: Boolean(req.headers()['authorization']), web: req.headers()['x-thechat-client'] === 'web' });
    }
  });
  await login(page, f.alice);
  await expect(page).toHaveURL(new RegExp(`/channel/${f.channel.id}`));
  expect(await page.evaluate(() => '__TAURI_INTERNALS__' in window)).toBe(false);
  expect(await page.evaluate(() => {
    const policy = (document as Document & { featurePolicy: { allowsFeature: (feature: string) => boolean } }).featurePolicy;
    return policy.allowsFeature("microphone");
  }), "The served document policy must allow same-origin microphone capture").toBe(true);
  expect((await page.context().cookies()).some(cookie => cookie.httpOnly)).toBe(true);
  expect(await page.evaluate(() => /auth_access_token|accessToken|Bearer /.test(JSON.stringify({ ...localStorage, ...sessionStorage })))).toBe(false);
  const messages = async (id: string): Promise<Array<{ id: string; attachments?: Array<{ id: string; fileName: string; mediaType: string; sizeBytes: number }> }>> => {
    const response = await page.context().request.get(`${apiURL}/messages/${id}`, { headers: webHeaders });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const evidence: Record<string, unknown> = { project: info.project.name, syntheticMicrophone: true, tauri: false, cookieAuth: true };
  await test.step('cancel releases native tracks without reserving or uploading', async () => {
    await page.getByRole('button', { name: 'Record voice message', exact: true }).click();
    await expect(page.getByRole('timer', { name: 'Recording duration' })).toContainText('0:01');
    expect((await tracks(page)).some(track => track.kind === 'audio' && track.state === 'live')).toBe(true);
    await page.getByRole('button', { name: 'Cancel recording', exact: true }).click();
    await assertReleased(page, 1);
    await expect(page.getByRole('button', { name: 'Record voice message', exact: true })).toBeVisible();
    await expect(page.getByLabel('Voice message preview', { exact: true })).toHaveCount(0);
    expect(traffic).toEqual({ reserves: 0, puts: 0, completes: 0, authorizations: 0 });
    expect(await messages(f.channel.id)).toHaveLength(0);
    evidence.cancel = { tracks: await tracks(page), traffic: { ...traffic } };
  });

  for (const [kind, id] of [['channel', f.channel.id], ['dm', f.dm.id]] as const) {
    await test.step(`${kind}: local review and one Send persist playable, downloadable voice bytes`, async () => {
      if (kind === 'dm') await page.goto(`/#/dm/${id}`);
      await expect(page).toHaveURL(new RegExp(`/${kind}/${id}`));
      const baseline = { ...traffic };
      const draftText = 'Keep this typed draft for later';
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill(draftText);
      const trackCount = (await tracks(page)).length;
      await page.getByRole('button', { name: 'Record voice message', exact: true }).click();
      await expect(page.getByRole('timer', { name: 'Recording duration' })).toContainText('0:02');
      await page.screenshot({ path: info.outputPath(`${kind}-recording.png`), fullPage: true });
      await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
      const preview = page.getByLabel('Voice message preview', { exact: true });
      await expect(preview).toBeAttached();
      await expect(preview).not.toHaveAttribute('controls');
      await expect(page.getByRole('button', { name: 'Attach recording', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Send voice message', exact: true })).toBeEnabled();
      await assertReleased(page, trackCount + 1);
      await expect(page.getByTitle('Send message', { exact: true })).toBeDisabled();
      await expect(preview).toHaveAttribute('src', /^blob:/);
      const recorded = await preview.evaluate(async (audio: HTMLAudioElement) => {
        const blob = await (await fetch(audio.src)).blob();
        const bytes = await blob.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        return { size: bytes.byteLength, mimeType: blob.type,
          sha256: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join(''),
          header: Array.from(new Uint8Array(bytes).slice(0, 4)),
        };
      });
      expect(recorded.size).toBeGreaterThan(1000);
      expect(recorded.mimeType).toBe('audio/webm');
      expect(recorded.header).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
      const previewPlayback = await playRealAudio(page, 'audio[aria-label="Voice message preview"]', 'Play voice message preview');
      // A 390px phone preview is required even when this run starts on desktop.
      const originalViewport = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      await assertContained(page, '[aria-label="Voice recording"]');
      await assertContained(page, '[aria-label="Send voice message"]');
      await expect(page.getByTitle('Send message', { exact: true })).toBeHidden();
      await page.screenshot({ path: info.outputPath(`${kind}-390-preview.png`), fullPage: true });
      expect(traffic).toEqual(baseline);
      expect(await messages(id)).toHaveLength(0);
      await page.setViewportSize(originalViewport);
      await page.screenshot({ path: info.outputPath(`${kind}-desktop-preview.png`), fullPage: true });

      await page.getByRole('button', { name: 'Send voice message', exact: true }).click();
      await expect(preview).toHaveCount(0, { timeout: 45_000 });
      await expect.poll(async () => (await messages(id)).length).toBe(1);
      expect(traffic.reserves - baseline.reserves).toBe(1);
      expect(traffic.puts - baseline.puts).toBe(1);
      expect(traffic.completes - baseline.completes).toBe(1);
      // One explicit Send owns both upload and acknowledged message creation.
      expect(await messages(id)).toHaveLength(1);
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(draftText);
      const stored = (await messages(id))[0];
      expect(stored.attachments).toHaveLength(1);
      const attachment = stored.attachments![0];
      expect(attachment.fileName).toBe('voice-message.webm');
      expect(attachment.mediaType).toBe('audio/webm');
      expect(attachment.sizeBytes).toBe(recorded.size);
      const load = page.getByRole('button', { name: 'Play voice message', exact: true });
      await expect(load).toBeVisible();
      expect(traffic.authorizations).toBe(baseline.authorizations);
      await page.reload();
      await expect(load).toBeVisible();
      expect(await page.getByLabel('Audio: voice-message.webm', { exact: true }).evaluateAll(elements => elements.some(element => element.hasAttribute('src')))).toBe(false);
      expect(traffic.authorizations).toBe(baseline.authorizations);
      await page.getByRole('button', { name: 'Playback speed 1×', exact: true }).click();
      await load.click();
      const audio = page.getByLabel('Audio: voice-message.webm', { exact: true });
      await expect(audio).toHaveAttribute('preload', 'none');
      await expect(audio).not.toHaveAttribute('controls');
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime), { message: 'First Play must both authorize and start the browser decoder' }).toBeGreaterThan(0.25);
      const playback = await audio.evaluate((element: HTMLAudioElement) => ({ currentTime: element.currentTime, error: element.error?.code ?? null }));
      expect(playback.error).toBeNull();
      expect(await audio.evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(1.5);
      expect(await audio.evaluate((element: HTMLAudioElement) => element.defaultPlaybackRate)).toBe(1.5);
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => Number.isFinite(element.duration) && element.duration > 0)).toBe(true);
      await expect(page.getByRole('slider', { name: 'Seek voice message', exact: true })).toBeEnabled();
      await page.screenshot({ path: info.outputPath(`${kind}-desktop-playback.png`), fullPage: true });
      expect(traffic.authorizations - baseline.authorizations).toBe(1);
      await page.setViewportSize({ width: 390, height: 844 });
      await assertContained(page, '[data-testid="voice-message-player"]');
      await assertContained(page, '[title="Send message"]');
      await page.screenshot({ path: info.outputPath(`${kind}-390-playback.png`), fullPage: true });
      const pendingDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download voice-message.webm', exact: true }).click();
      const download = await pendingDownload;
      expect(download.suggestedFilename()).toBe('voice-message.webm');
      const downloadedPath = info.outputPath(`${kind}-voice-message.webm`);
      await download.saveAs(downloadedPath);
      const bytes = await readFile(downloadedPath);
      expect(bytes.length).toBe(recorded.size);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(recorded.sha256);
      expect(traffic.authorizations - baseline.authorizations).toBe(2);
      evidence[kind] = { recorded, previewPlayback, playback, messageId: stored.id, attachmentId: attachment.id, downloadedBytes: bytes.length, traffic: { ...traffic } };
      await page.setViewportSize(originalViewport);
    });
  }
  expect(apiRequests.length).toBeGreaterThan(0);
  expect(apiRequests.every(req => !req.bearer && req.web), 'Attachment and send requests must use browser-cookie auth').toBe(true);
  expect(errors).toEqual([]);
  await writeFile(info.outputPath('voice-evidence.json'), JSON.stringify({ ...evidence, apiRequests, pageErrors: errors }, null, 2));
});
