import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

let server;
let baseUrl;
const artifacts = process.env.RELEASE_NOTES_ARTIFACTS;
before(async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  server = await createServer({ root, mode: "web", configFile: `${root}vite.config.ts`,
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false }, logLevel: "error" });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  if (artifacts) await mkdir(artifacts, { recursive: true });
});
after(async () => { await server?.close(); });
const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
  test(`${engineName}: release notes, Settings, preview and account lifecycle`, async (t) => {
    const browser = await engine.launch();
    t.after(() => browser.close());
    for (const width of [1280, 390]) {
      await t.test(`${width}px`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        try {
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.route("**/auth/personal-access-tokens", (route) => route.fulfill({ json: { personalAccessTokens: [] } }));
          await page.goto(`${baseUrl}/browser-tests/fixtures/release-notes.html`);
          const dialog = page.getByRole("dialog", { name: "What's new", exact: true });
          await dialog.waitFor();
          await settle(page);
          const bounds = await dialog.boundingBox();
          assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 800, JSON.stringify(bounds));
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          const scroller = page.getByTestId("release-notes-scroll");
          assert.ok(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight));
          assert.ok(await scroller.evaluate((el) => el.scrollWidth <= el.clientWidth));
          assert.equal(await page.locator('a[href^="javascript:"], script:not([src]):not([type="module"])').count(), 0);
          assert.equal(await page.evaluate(() => window.releaseNotesUnsafe), undefined);
          assert.equal(await dialog.getByRole("link", { name: "Documentation" }).getAttribute("rel"), "noopener noreferrer");
          for (let i = 0; i < 7; i++) {
            await page.keyboard.press("Tab");
            assert.ok(await dialog.evaluate((el) => el.contains(document.activeElement)));
          }
          if (artifacts) await page.screenshot({ path: `${artifacts}/${engineName}-${width}-release-notes.png` });
          await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
          assert.ok(await scroller.evaluate((el) => el.scrollTop > 0));
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "detached" });
          await page.reload();
          await page.getByRole("heading", { name: "Profile", exact: true }).waitFor();
          await settle(page);
          assert.equal(await page.getByRole("dialog").count(), 0);

          const settingsTrigger = page.getByRole("button", { name: "What's new", exact: true });
          await settingsTrigger.click();
          await dialog.waitFor();
          await page.getByRole("combobox", { name: "Release history" }).selectOption("0.9.0");
          assert.equal(await page.getByRole("combobox", { name: "Release history" }).evaluate((el) => getComputedStyle(el).appearance), "none", "native select chrome must not override dark theme colors");
          assert.ok(await scroller.evaluate((el) => el.scrollWidth <= el.clientWidth), "bundled release must not horizontally overflow");
          assert.ok(await dialog.getByRole("article").textContent());
          if (artifacts) await page.screenshot({ path: `${artifacts}/${engineName}-${width}-bundled-release.png` });
          await page.keyboard.press("Escape");
          await settle(page);
          assert.ok(await settingsTrigger.evaluate((el) => el === document.activeElement));

          await page.getByRole("button", { name: "Commands", exact: true }).click();
          await page.getByPlaceholder("Type a command...").fill("What's new");
          await page.getByPlaceholder("Type a command...").press("Enter");
          await dialog.waitFor();
          await page.keyboard.press("Escape");
          await settle(page);
          assert.ok(await page.getByRole("textbox", { name: "Fixture composer" }).evaluate((el) => el === document.activeElement));

          await page.getByRole("button", { name: "Preview available update" }).click();
          await page.getByRole("dialog", { name: "Update release notes" }).waitFor();
          assert.ok(await page.getByRole("heading", { name: "Upcoming preview" }).isVisible());
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Simulate updated bundle" }).click();
          await dialog.waitFor();
          assert.match(await dialog.textContent(), /Running TheChat 0\.9\.0/);
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Switch account" }).click();
          await dialog.waitFor();
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });
    }
  });
}


for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
  test(`${engineName}: permanent opt-out in the manual review preview`, async (t) => {
    const browser = await engine.launch();
    t.after(() => browser.close());
    for (const width of [1280, 390]) {
      await t.test(`${width}px`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        try {
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`${baseUrl}/browser-tests/fixtures/release-notes-review.html`);
          const dialog = page.getByRole("dialog", { name: "What's new", exact: true });
          await dialog.waitFor();
          const checkbox = page.getByRole("checkbox", { name: "Don't show release notes automatically" });
          assert.equal(await checkbox.isChecked(), false);
          const bounds = await checkbox.boundingBox();
          assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 800);
          await checkbox.check();
          assert.ok(await dialog.isVisible());
          if (artifacts) await page.screenshot({ path: `${artifacts}/${engineName}-${width}-optout.png` });
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Simulate another release" }).click();
          await settle(page);
          assert.equal(await page.getByRole("dialog").count(), 0);
          await page.reload();
          await page.getByRole("heading", { name: "Release notes review", exact: true }).waitFor();
          await settle(page);
          assert.equal(await page.getByRole("dialog").count(), 0);
          await page.getByRole("button", { name: "Show release notes", exact: true }).click();
          await dialog.waitFor();
          assert.equal(await checkbox.isChecked(), true);
          await checkbox.uncheck();
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Simulate another release" }).click();
          await dialog.waitFor();
          assert.equal(await checkbox.isChecked(), false);
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Reset demo" }).click();
          await dialog.waitFor();
          assert.equal(await checkbox.isChecked(), false);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });
    }
  });
}
