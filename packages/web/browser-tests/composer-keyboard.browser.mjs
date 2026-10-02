import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

let server;
let baseUrl;
before(async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  server = await createServer({
    root, configFile: `${root}vite.config.ts`,
    cacheDir: path.join(tmpdir(), `thechat-composer-keyboard-vite-${process.pid}`),
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    logLevel: "error",
  });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
});
after(async () => { await server?.close(); });

for (const engine of [chromium, webkit]) {
  for (const touch of [true, false]) {
    for (const width of [390, 1200]) {
      test(`${engine.name()}: ${touch ? "touch" : "desktop"} Enter at ${width}px`, async (t) => {
        const browser = await engine.launch();
        t.after(() => browser.close());
        const page = await browser.newPage({
          viewport: { width, height: 844 }, hasTouch: touch, isMobile: touch,
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${baseUrl}/browser-tests/fixtures/composer-keyboard.html`);
        const editor = page.getByRole("textbox", { name: "Message" });
        await editor.waitFor();
        assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), touch);
        await editor.click();
        await page.keyboard.type("first line");
        await page.keyboard.press("Enter");
        if (touch) {
          assert.equal(await page.getByTestId("sent-source").count(), 0);
          assert.equal(await editor.locator("p").count(), 2);
          await page.keyboard.press("Enter");
          await page.keyboard.type("third line");
          await page.waitForFunction(() => document.querySelector('[data-testid="draft"]').textContent === "first line\n\nthird line");
          assert.equal(await page.getByTestId("sent-source").count(), 0);
          if (process.env.THECHAT_KEYBOARD_EVIDENCE_DIR) {
            await mkdir(process.env.THECHAT_KEYBOARD_EVIDENCE_DIR, { recursive: true });
            await page.screenshot({ path: path.join(process.env.THECHAT_KEYBOARD_EVIDENCE_DIR, `${engine.name()}-touch-${width}.png`), fullPage: true });
          }
          await page.getByTitle("Send message", { exact: true }).click();
          await page.getByTestId("sent-source").waitFor();
          assert.equal(await page.getByTestId("sent-source").textContent(), "first line\n\nthird line");
        } else {
          await page.getByTestId("sent-source").waitFor();
          assert.equal(await page.getByTestId("sent-source").textContent(), "first line");
        }
        await page.waitForFunction(() => document.querySelector('[role="textbox"]').textContent === "");
        // Shift+Enter remains a newline on both desktop and touch devices.
        await editor.click();
        await page.keyboard.type("shift line");
        await page.keyboard.press("Shift+Enter");
        await page.keyboard.type("second line");
        assert.equal(await page.getByTestId("sent-source").count(), 1);
        assert.equal(await page.getByTestId("draft").textContent(), "shift line\nsecond line");
        await page.getByTitle("Send message", { exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll('[data-testid="sent-source"]').length === 2);
        assert.equal(await page.getByTestId("sent-source").nth(1).textContent(), "shift line\nsecond line");
        // An empty mobile Return must not attempt attachment-only submission.
        if (touch) {
          await editor.click();
          await page.keyboard.press("Enter");
          assert.equal(await editor.locator("p").count(), 2);
          assert.equal(await page.getByTestId("sent-source").count(), 2);
        }
        assert.deepEqual(errors, []);
      });
    }
  }
}
