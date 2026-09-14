import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

let server;
let baseUrl;
const evidenceDir = process.env.THECHAT_COPY_EVIDENCE_DIR;
before(async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  server = await createServer({
    root,
    configFile: `${root}vite.config.ts`,
    cacheDir: path.join(tmpdir(), `thechat-copy-vite-${process.pid}`),
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    logLevel: "error",
  });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
});
after(async () => { await server?.close(); });

const source = "  **Hello** 👋\n\n```ts\nconst answer = 42;\n```\n";
test("copy uses the real browser clipboard in shared chat views", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const view of ["channel", "hermes"]) {
    for (const width of [1280, 390]) {
      await t.test(`${view}, ${width}px`, async () => {
        const context = await browser.newContext({
          viewport: { width, height: 800 },
          permissions: ["clipboard-read", "clipboard-write"],
          hasTouch: width === 390,
        });
        try {
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`${baseUrl}/browser-tests/fixtures/chat.html?view=${view}&copy=1`);
          const row = page.locator('[data-message-id="message-29"]');
          const copy = row.getByRole("button", { name: "Copy message" });
          await copy.waitFor();
          await row.scrollIntoViewIfNeeded();
          await page.evaluate(() => document.fonts.ready);
          if (width > 1023) {
            await page.mouse.move(0, 0);
            assert.equal(await copy.locator("..").evaluate((el) => getComputedStyle(el).opacity), "0");
            await row.hover();
          }
          assert.equal(await copy.locator("..").evaluate((el) => getComputedStyle(el).opacity), "1");
          const reaction = row.getByRole("button", { name: "Add reaction" });
          const a = await reaction.boundingBox();
          const b = await copy.boundingBox();
          assert.ok(a && b && a.x + a.width <= b.x && Math.abs(a.y - b.y) < 1, "actions must be adjacent, not overlapping");
          if (width === 390) assert.ok(b.width >= 44 && b.height >= 44, "touch target must be at least 44px");
          assert.ok(b.x >= 0 && b.x + b.width <= width);
          await copy.click();
          await page.waitForFunction(() => document.querySelector('[data-message-id="message-29"] [role="status"]')?.textContent === "Message copied");
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), source);
          assert.equal(await copy.getAttribute("title"), "Copied!");
          if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, `${view}-${width}.png`) });
          await page.waitForFunction(() => document.querySelector('[data-message-id="message-29"] [aria-label="Copy message"]')?.getAttribute("title") === "Copy message");

          // Keyboard activation also copies the right row when reactions exist.
          const reactedRow = page.locator('[data-message-id="message-28"]');
          const reactedCopy = reactedRow.getByRole("button", { name: "Copy message" });
          await reactedCopy.focus();
          await page.keyboard.press("Enter");
          await page.waitForFunction(() => document.querySelector('[data-message-id="message-28"] [role="status"]')?.textContent === "Message copied");
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "Message 28: Some previous conversation history.");
          assert.equal(await reactedRow.getByRole("button", { name: "👍 1 reaction" }).count(), 1);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    }
  }
});
