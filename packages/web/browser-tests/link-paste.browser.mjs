import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

const label = "KGSP 18-140 I V.mp4";
const href = "https://example.com/?file=KGSP%2018-140%20I%20V.mp4&e=Demo123&download=1#preview";
const markdown = `[${label}](${href})`;
let server;
let baseUrl;
before(async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  server = await createServer({
    root, configFile: `${root}vite.config.ts`,
    cacheDir: path.join(tmpdir(), `thechat-link-paste-vite-${process.pid}`),
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    logLevel: "error",
  });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
});
after(async () => { await server?.close(); });

// Selection via DOM Range, but copy/paste uses native keyboard and clipboard.
// No ClipboardEvent construction, clipboard stubbing, or mocked editor content.
async function copyPaste(page, source) {
  await page.getByTestId(source).evaluate((element) => {
    const range = document.createRange();
    range.selectNode(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press("ControlOrMeta+c");
  await page.getByRole("textbox", { name: "Message" }).click();
  await page.keyboard.press("ControlOrMeta+v");
}

async function assertSent(page, index, source) {
  const message = page.getByTestId("sent-message").nth(index);
  await message.waitFor();
  assert.equal(await message.getByTestId("sent-source").textContent(), source);
  const link = message.getByTestId("rendered-message").locator("a");
  assert.equal(await link.count(), 1);
  assert.equal(await link.getAttribute("href"), href);
  assert.equal(await link.textContent(), source === href ? href : label);
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: native named-link clipboard survives send and draft switches`, async (t) => {
    const browser = await engine.launch();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/browser-tests/fixtures/link-paste.html`);
    const editor = page.getByRole("textbox", { name: "Message" });
    await editor.waitFor();

    await copyPaste(page, "copy-source");
    // Prove native clipboard included HTML, not just the plain filename.
    await editor.locator("a").waitFor();
    assert.equal(await editor.locator("a").getAttribute("href"), href);
    assert.equal(await page.getByTestId("draft").textContent(), markdown);
    await page.getByTitle("Send message", { exact: true }).click();
    await assertSent(page, 0, markdown);
    await page.waitForFunction(() => document.querySelector('[role="textbox"]').textContent === "");

    await copyPaste(page, "copy-source");
    await editor.locator("a").waitFor();
    await page.getByRole("button", { name: "Draft B", exact: true }).click();
    assert.equal(await editor.textContent(), "");
    await editor.fill("separate B draft");
    await page.getByRole("button", { name: "Draft A", exact: true }).click();
    assert.equal(await editor.textContent(), markdown);
    assert.equal(await editor.locator("a").count(), 0, "restored strings must remain literal");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    // Real typing/autolinking after restoration must not wrap its destination.
    await page.keyboard.type(" edited");
    assert.equal(await page.getByTestId("draft").textContent(), `${markdown} edited`);
    await page.keyboard.press("Enter");
    await assertSent(page, 1, `${markdown} edited`);
    await page.getByRole("button", { name: "Draft B", exact: true }).click();
    assert.equal(await editor.textContent(), "separate B draft");
    await page.getByRole("button", { name: "Draft A", exact: true }).click();

    await copyPaste(page, "plain-source");
    await page.waitForFunction((value) => document.querySelector('[data-testid="draft"]').textContent === value, href);
    await page.keyboard.press("Enter");
    await assertSent(page, 2, href);
    assert.deepEqual(errors, []);
  });
}
