import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = process.env.UPDATE_EVIDENCE_DIR || await mkdtemp(path.resolve(root, "../../../update-ui-evidence-"));
await mkdir(evidence, { recursive: true });
const server = await createServer({
  configFile: path.join(root, "vite.config.ts"),
  cacheDir: path.join(evidence, "vite-cache"),
  server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
});
await server.listen();
const address = server.httpServer.address();
const url = `http://127.0.0.1:${address.port}/browser-tests/fixtures/updater.html`;
const results = [];
try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
        const page = await browser.newPage({ viewport });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        // A fixture must never reach a real account or API.
        await page.route("**/*", route => {
          const requestUrl = new URL(route.request().url());
          return requestUrl.origin === new URL(url).origin ? route.continue() : route.abort();
        });
        try {
          await page.goto(url);
          await page.getByRole("heading", { name: "Update indicator review" }).waitFor();
          assert.equal(await page.getByRole("button", { name: /^Update available/ }).count(), 0);
          await page.evaluate(() => window.updateReview.begin());
          if (viewport.width < 1024) await page.getByRole("button", { name: "Open navigation" }).click();
          const downloading = page.getByRole("button", { name: /^Downloading update/ });
          await downloading.waitFor();
          assert.equal(await downloading.isDisabled(), true);
          assert.match(await downloading.innerText(), /42%/);
          await page.evaluate(() => window.updateReview.finishDownload());
          const ready = page.getByRole("button", { name: /^Update available/ });
          await ready.waitFor();
          // The modal navigation drawer makes the background toast inert.
          await page.getByRole("button", { name: "Restart to update", includeHidden: true }).waitFor({ state: "attached" });
          const account = page.getByRole("button", { name: /Alex Example/ });
          const before = await ready.boundingBox();
          const accountBox = await account.boundingBox();
          assert(before && accountBox);
          assert(before.x >= 0 && before.x + before.width <= viewport.width);
          assert(before.y + before.height <= accountBox.y);
          assert(accountBox.y + accountBox.height <= viewport.height);
          // Use the desktop stylesheet, including its Tailwind source boundary.
          // A shared-CSS-only fixture can put an unstyled toast over this footer.
          assert.equal(await ready.evaluate(el => getComputedStyle(el).display), "flex");
          if (viewport.width >= 1024) {
            const toast = await page.getByRole("button", { name: "Restart to update" }).boundingBox();
            assert(toast.x > before.x + before.width, "toast stays clear of the footer");
          }
          const scrolled = await page.evaluate(() => {
            const element = [...document.querySelectorAll("div")].find(el => getComputedStyle(el).overflowY === "auto" && el.scrollHeight > el.clientHeight);
            if (!element) return false;
            element.scrollTop = element.scrollHeight;
            return element.scrollTop > 0;
          });
          assert.equal(scrolled, true, "long channel list is independently scrollable");
          const after = await ready.boundingBox();
          assert(Math.abs(after.y - before.y) < 1, "update button stays pinned during sidebar scroll");
          await account.click();
          await page.getByRole("button", { name: "Log out" }).waitFor();
          await account.click();
          await page.screenshot({ path: path.join(evidence, `${name}-${viewport.width}-ready.png`) });
          await ready.focus();
          await page.keyboard.press("Enter");
          await page.getByRole("button", { name: /^Installing update/ }).first().waitFor();
          const installingButtons = page.getByRole("button", { name: /^Installing update/, includeHidden: true });
          assert.equal(await installingButtons.count(), 2);
          for (const button of await installingButtons.all()) assert.equal(await button.isDisabled(), true);
          const calls = await page.evaluate(() => window.updateReview.calls);
          assert.equal(calls.filter(command => command === "plugin:updater|install").length, 1);
          await page.evaluate(() => window.updateReview.finishInstall());
          await page.waitForFunction(() => window.updateReview.calls.includes("plugin:process|restart"));
          assert.deepEqual(errors, []);
          results.push({ browser: name, viewport, pinnedFooter: true, accountMenu: true, downloadProgress: true, keyboardInstall: true, nativeBoundary: "simulated" });
        } catch (error) {
          await page.screenshot({ path: path.join(evidence, `${name}-${viewport.width}-failure.png`) });
          await writeFile(path.join(evidence, "failure.txt"), `${error.stack}\n${errors.join("\n")}\n${await page.locator("body").innerText()}`);
          throw error;
        } finally { await page.close(); }
      }
    } finally { await browser.close(); }
  }
  await writeFile(path.join(evidence, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: results.length, results, evidence }, null, 2));
} finally { await server.close(); }
