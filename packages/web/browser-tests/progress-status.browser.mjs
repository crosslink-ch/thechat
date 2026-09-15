import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

let server;
let baseUrl;
before(async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  server = await createServer({
    root,
    configFile: `${root}vite.config.ts`,
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    logLevel: "error",
  });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
});
after(async () => { await server?.close(); });

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`${name}: progress status is calm, readable and actionable`, async (t) => {
    const browser = await engine.launch();
    t.after(() => browser.close());
    for (const width of [1280, 390, 320]) {
      for (const state of ["running", "queued", "approval", "clarify"]) {
        await t.test(`${state}, ${width}px`, async () => {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          try {
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(`${baseUrl}/browser-tests/fixtures/progress.html?state=${state}`);
            const title = page.getByText({ running: "Koda is working", queued: "Koda is queued", approval: "Koda is waiting for your approval", clarify: "Koda is waiting for your response" }[state], { exact: true });
            await title.waitFor();
            await page.evaluate(() => document.fonts.ready);
            const header = title.locator("..");
            assert.equal(await header.locator(".animate-pulse").count(), 0);
            assert.equal(await header.getByText("active", { exact: true }).count(), 0);
            assert.equal(await header.getByText("queued", { exact: true }).count(), 0);
            assert.equal(await header.getByText("action needed", { exact: true }).count(), ["approval", "clarify"].includes(state) ? 1 : 0);
            const layout = await header.evaluate((el) => {
              const bounds = el.getBoundingClientRect();
              return {
                flex: getComputedStyle(el).display,
                animated: [el, ...el.querySelectorAll("*")].some((child) => getComputedStyle(child).animationName !== "none"),
                fits: [el, ...el.children].filter((child) => child.textContent.trim()).every((child) => {
                  const rect = child.getBoundingClientRect();
                  return rect.width > 0 && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && child.scrollWidth <= child.clientWidth + 1;
                }),
                pageFits: document.documentElement.scrollWidth <= innerWidth,
              };
            });
            assert.equal(layout.flex, "flex", "production utility CSS must be present");
            assert.equal(layout.animated, false);
            assert.equal(layout.fits, true, JSON.stringify(layout));
            assert.equal(layout.pageFits, true);
            if (state === "queued") {
              assert.equal(await header.getByRole("button", { name: "Stop", exact: true }).count(), 0);
            } else {
              const stop = header.getByRole("button", { name: "Stop", exact: true });
              await stop.focus();
              await page.keyboard.press("Enter");
              await title.waitFor({ state: "detached" });
            }
            assert.deepEqual(errors, []);
          } finally {
            await page.close();
          }
        });
      }
    }
  });
}
