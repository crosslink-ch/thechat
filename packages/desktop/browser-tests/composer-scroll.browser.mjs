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

const settle = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
}));
const geometry = (scroller) => scroller.evaluate((el) => ({
  top: el.scrollTop,
  gap: el.scrollHeight - el.clientHeight - el.scrollTop,
}));

for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
  test(`${engineName}: clearing the composer preserves message scroll`, async (t) => {
    const browser = await engine.launch();
    t.after(() => browser.close());
    for (const view of ["channel", "hermes"]) {
      for (const width of [1280, 390]) {
        await t.test(`${view}, ${width}px`, async () => {
          const page = await browser.newPage({ viewport: { width, height: 800 } });
          try {
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(`${baseUrl}/browser-tests/fixtures/chat.html?view=${view}`);
            const editor = page.locator(".ProseMirror");
            const scroller = page.getByTestId(
              view === "channel" ? "channel-chat-scroll" : "hermes-dm-chat-scroll",
            );
            await editor.waitFor();
            await page.evaluate(() => document.fonts.ready);
            await settle(page);
            assert.ok(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight));
            await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
            await settle(page);
            const initialHeight = await editor.evaluate((el) => el.clientHeight);

            // Native keyboard deletion briefly empties the paragraph before
            // the browser/Tiptap repairs it. jsdom does not perform this layout.
            for (const deletion of ["Backspace", "Delete", "select-all"]) {
              await editor.click();
              await page.keyboard.type("x");
              await settle(page);
              assert.ok((await geometry(scroller)).gap <= 1, "typing must stay at bottom");
              if (deletion === "Delete") await page.keyboard.press("Home");
              if (deletion === "select-all") await page.keyboard.press("ControlOrMeta+A");
              // Let native selectionchange reach ProseMirror before Delete.
              await settle(page);
              await page.keyboard.press(deletion === "Delete" ? "Delete" : "Backspace");
              await settle(page);
              assert.equal(await editor.textContent(), "", `${deletion} must delete the character`);
              assert.ok((await geometry(scroller)).gap <= 1,
                `${deletion} moved the chat away from bottom: ${JSON.stringify(await geometry(scroller))}`);
              assert.equal(await editor.evaluate((el) => el.clientHeight), initialHeight);
            }

            // A fix must not force bottom-following when reading older history.
            await scroller.evaluate((el) => { el.scrollTop -= 300; });
            await settle(page);
            const readingPosition = (await geometry(scroller)).top;
            await editor.click();
            await page.keyboard.type("x");
            await page.keyboard.press("Backspace");
            await settle(page);
            assert.ok(Math.abs((await geometry(scroller)).top - readingPosition) <= 1);
            assert.ok((await geometry(scroller)).gap > 200);

            // The minimum line height must not prevent normal multiline growth
            // or scrolling within a long composer.
            await page.keyboard.type("first");
            await page.keyboard.press("Shift+Enter");
            await page.keyboard.type("second");
            await settle(page);
            assert.equal(await editor.locator("p").count(), 2);
            assert.ok(await editor.evaluate((el) => el.clientHeight) > initialHeight);
            for (let line = 0; line < 12; line++) {
              await page.keyboard.press("Shift+Enter");
              await page.keyboard.type(`line ${line}`);
            }
            await settle(page);
            assert.ok(await editor.evaluate((el) => el.scrollHeight > el.clientHeight));
            assert.ok(await editor.evaluate((el) => el.clientHeight <= 200));
            assert.deepEqual(errors, []);
          } finally {
            await page.close();
          }
        });
      }
    }
  });
}
