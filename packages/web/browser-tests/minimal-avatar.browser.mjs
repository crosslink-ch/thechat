import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

// Component/store integration with real browser input and rendering, not live
// API/authentication or compiled Tauri E2E. Screenshot evidence stays external.
let server, baseUrl, cacheDir;
const results = [];
const out = process.env.MINIMAL_ARTIFACTS_DIR;
before(async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimal-avatar-vite-"));
  if (out) await fs.mkdir(out, { recursive: true });
  server = await createServer({
    root, configFile: path.join(root, "vite.config.ts"), cacheDir,
    mode: "web", server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    logLevel: "error",
  });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
});
after(async () => {
  await server?.close();
  if (cacheDir) await fs.rm(cacheDir, { recursive: true, force: true });
  if (out) await fs.writeFile(path.join(out, "acceptance.json"), JSON.stringify(results, null, 2));
});
const settle = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
}));
const styles = (locator) => locator.evaluate((el) => ({
  animation: getComputedStyle(el).animationName,
  duration: getComputedStyle(el).animationDuration,
  transform: getComputedStyle(el).transform,
}));
async function fits(page) {
  const geometry = await page.evaluate(() => ({
    width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    controls: [...document.querySelectorAll('button, [data-testid="progress-area"]')].map((el) => {
      const { x, width } = el.getBoundingClientRect();
      return { label: el.getAttribute("aria-label") || el.textContent, x, width };
    }),
  }));
  assert.ok(geometry.scrollWidth <= geometry.width, JSON.stringify(geometry));
  for (const rect of geometry.controls) {
    assert.ok(rect.width > 0 && rect.x >= -1 && rect.x + rect.width <= geometry.width + 1,
      `clipped control: ${JSON.stringify(rect)}`);
  }
  return geometry;
}
for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
  for (const width of [390, 1024]) {
    for (const reducedMotion of ["no-preference", "reduce"]) {
      test(`${engineName}, ${width}px, ${reducedMotion}: explicit Minimal and preserved activity`, { timeout: 60000 }, async (t) => {
        const browser = await engine.launch();
        t.after(() => browser.close());
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const record = { engine: engineName, width, reducedMotion, screenshots: [], states: [] };
        const shot = async (state) => {
          if (!out) return;
          const filename = path.join(out, `${engineName}-${width}-${reducedMotion}-${state}.png`);
          await page.screenshot({ path: filename, fullPage: true });
          record.screenshots.push(filename);
        };
        try {
          await page.goto(`${baseUrl}/browser-tests/fixtures/minimal-avatar.html`);
          await page.getByRole("button", { name: "Minimal bot", exact: true }).waitFor();
          await page.getByTestId("avatar-preview").locator("canvas").waitFor();
          await page.evaluate(() => document.fonts.ready);
          const progress = page.getByTestId("progress-area");
          const bot = progress.locator('canvas[aria-label*="bot"]');
          await bot.waitFor();
          assert.match(await bot.getAttribute("aria-label"), /Ghost bot, working/i);
          const workingFrame = await bot.evaluate((el) => el.toDataURL());
          if (reducedMotion === "no-preference") {
            await page.waitForTimeout(500);
            assert.notEqual(await bot.evaluate((el) => el.toDataURL()), workingFrame, "playful running avatar must animate");
          }
          await fits(page);
          await shot("playful-running");

          // Native pointer selection opts in. Ordinary message/list avatar also
          // switches via the same real workspace store; people stay unchanged.
          const person = await page.getByTestId("person-avatar").innerHTML();
          await page.getByRole("button", { name: "Minimal bot", exact: true }).click();
          await page.getByTestId("avatar-preview").locator("[data-bot-minimal]").waitFor();
          const indicator = progress.getByTestId("hermes-invocation-indicator");
          const spinner = indicator.locator(".lucide-loader-circle");
          await spinner.waitFor();
          assert.equal(await bot.count(), 0);
          assert.equal(await page.getByTestId("person-avatar").innerHTML(), person);
          assert.match(await page.getByRole("button", { name: "Minimal bot" }).getAttribute("aria-pressed"), /true/);
          assert.match(await page.locator("main").textContent(), /only when you select it, never by default or at random/);
          const spinnerStyle = await styles(spinner);
          assert.equal(spinnerStyle.animation, reducedMotion === "reduce" ? "none" : "spin");
          if (reducedMotion === "no-preference") assert.equal(spinnerStyle.duration, "1s");
          assert.equal(await indicator.getAttribute("aria-hidden"), "true");
          assert.equal(await indicator.evaluate((el) => getComputedStyle(el).display), "flex");
          assert.equal(await indicator.evaluate((el) => el.getBoundingClientRect().width), 28); // size-8 at production 14px root
          // The displayed conversation is independent from sidebar selection.
          await page.getByRole("button", { name: "Switch to unrelated workspace", exact: true }).click();
          await spinner.waitFor();
          assert.equal(await bot.count(), 0);
          assert.equal(await page.getByTestId("avatar-preview").locator("[data-bot-minimal]").count(), 1);
          await page.getByRole("button", { name: "Return to assistant workspace", exact: true }).click();
          const deep = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion });
          deep.on("pageerror", (error) => errors.push(error.message));
          try {
            await deep.goto(`${baseUrl}/browser-tests/fixtures/minimal-avatar.html?shape=minimal&workspace=unrelated`);
            await deep.getByTestId("progress-area").locator(".lucide-loader-circle").waitFor();
            assert.equal(await deep.getByTestId("progress-area").locator('canvas[aria-label*="bot"]').count(), 0);
            assert.equal(await deep.getByTestId("avatar-preview").locator("[data-bot-minimal]").count(), 1);
            await fits(deep);
          } finally {
            await deep.close();
          }
          record.states.push({ state: "running", spinnerStyle, geometry: await fits(page) });
          await page.getByRole("button", { name: /^Thinking/ }).click();
          assert.match(await progress.getByTestId("hermes-activity-detail").textContent(), /Check the synthetic acceptance evidence/);
          const elapsed = progress.locator(".tabular-nums");
          const beforeTime = await elapsed.textContent();
          await page.waitForTimeout(1100);
          assert.notEqual(await elapsed.textContent(), beforeTime, "elapsed timer must tick");
          await progress.getByRole("button", { name: "Stop", exact: true }).click();
          assert.match(await page.getByTestId("callback-log").textContent(), /stop/);
          await shot("minimal-running");

          // All motion requests must leave the glyph inert, including pointer
          // movement/clicks. No animation CSS, canvas, face or SVG SMIL.
          for (const motion of ["still", "idle", "live", "working", "sleeping"]) {
            const sample = page.getByTestId(`motion-${motion}`);
            const glyph = sample.locator("[data-bot-minimal]");
            const before = await glyph.evaluate((el) => ({ html: el.innerHTML, transform: getComputedStyle(el).transform }));
            await glyph.hover();
            await glyph.click();
            await page.mouse.move(0, 0);
            await settle(page);
            assert.deepEqual(await glyph.evaluate((el) => ({ html: el.innerHTML, transform: getComputedStyle(el).transform })), before);
            assert.equal(await sample.locator("canvas, circle, ellipse, animate, animateTransform").count(), 0);
            assert.equal((await styles(glyph)).animation, "none");
            assert.equal(await glyph.evaluate((el) => el.getAnimations({ subtree: true }).length), 0);
          }

          for (const state of ["queued", "approval", "clarification"]) {
            await page.getByRole("button", { name: `Show ${state}`, exact: true }).click();
            const marker = indicator.locator(state === "queued" ? ".lucide-clock-3" : ".lucide-circle-alert");
            await marker.waitFor();
            assert.equal(await spinner.count(), 0);
            assert.equal((await styles(marker)).animation, "none");
            if (state === "queued") {
              assert.equal(await progress.getByRole("button", { name: "Stop" }).count(), 0);
            } else {
              assert.match(await progress.textContent(), /action needed/);
              assert.equal(await progress.getByRole("button", { name: "Stop" }).count(), 1);
            }
            record.states.push({ state, markerStyle: await styles(marker), geometry: await fits(page) });
            await shot(`minimal-${state}`);
            if (state === "approval") {
              await progress.getByRole("button", { name: "Approve", exact: true }).click();
              await spinner.waitFor();
              assert.match(await page.getByTestId("callback-log").textContent(), /approval.request:"once"/);
            } else if (state === "clarification") {
              await progress.getByRole("button", { name: "Safe", exact: true }).click();
              await spinner.waitFor();
              assert.match(await page.getByTestId("callback-log").textContent(), /clarify.request:"Safe"/);
            }
          }

          // Native keyboard switches back: Ghost immediately follows Blob in
          // the real picker. No synthetic click or dispatched keyboard event.
          await page.getByRole("button", { name: "Show running" }).click();
          await page.getByRole("button", { name: "Blob bot", exact: true }).click();
          await page.keyboard.press("Tab");
          assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Ghost bot");
          await page.keyboard.press("Enter");
          await bot.waitFor();
          assert.match(await bot.getAttribute("aria-label"), /Ghost bot, working/i);
          assert.equal(await indicator.count(), 0);
          await page.getByRole("button", { name: "Show approval" }).click();
          await bot.waitFor();
          assert.match(await bot.getAttribute("aria-label"), /Ghost bot, idle/i);
          const idleFrame = await bot.evaluate((el) => el.toDataURL());
          if (reducedMotion === "no-preference") {
            await page.waitForTimeout(1500);
            assert.notEqual(await bot.evaluate((el) => el.toDataURL()), idleFrame, "playful waiting avatar must idle");
          }
          await fits(page);
          await shot("playful-waiting");
          await page.getByRole("button", { name: "Puddle bot", exact: true }).click();
          await page.keyboard.press("Tab");
          assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Minimal bot");
          await page.keyboard.press("Enter");
          await indicator.locator(".lucide-circle-alert").waitFor();
          assert.deepEqual(errors, []);
          record.pass = true;
        } catch (error) {
          record.pass = false;
          record.error = String(error);
          await shot("failure");
          throw error;
        } finally {
          record.errors = errors;
          results.push(record);
          await page.close();
        }
      });
    }
  }
}
