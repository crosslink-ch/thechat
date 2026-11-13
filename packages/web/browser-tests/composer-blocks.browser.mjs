import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

// Real keyboard input in real engines: Markdown shortcuts, the # and : menus,
// Enter rules, and the sent message rendering the same blocks.
let server;
let baseUrl;
before(async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  server = await createServer({
    root, configFile: `${root}vite.config.ts`,
    cacheDir: path.join(tmpdir(), `thechat-composer-vite-${process.pid}`),
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    logLevel: "error",
  });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
});
after(async () => { await server?.close(); });

async function openComposer(engine, t) {
  const browser = await engine.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const editor = page.getByRole("textbox", { name: "Message" });
  // A cold Vite server may reload the page once while it optimizes deps.
  for (let attempt = 0; ; attempt++) {
    await page.goto(`${baseUrl}/browser-tests/fixtures/composer.html`);
    try {
      await editor.waitFor({ timeout: 20_000 });
      break;
    } catch (error) {
      if (attempt > 0) throw error;
    }
  }
  await editor.click();
  return { page, editor, errors };
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: blocks and menus round-trip through a send`, async (t) => {
    const { page, editor, errors } = await openComposer(engine, t);

    await page.keyboard.type("Plan for ");
    await page.keyboard.type(":tad");
    await page.getByTestId("emoji-menu").waitFor();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("- **ship** it");
    await page.keyboard.press("Enter");
    await page.keyboard.type("test it");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("#cod");
    await page.getByTestId("block-menu").waitFor();
    await page.keyboard.press("Enter");
    await page.keyboard.type("const done = true;");
    await page.keyboard.press("Enter");
    await page.keyboard.type("return done;");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("> at 10:30 :+1:");

    assert.equal(await editor.locator("ul > li").count(), 2);
    assert.equal(await editor.locator("li strong").textContent(), "ship");
    assert.equal(await editor.locator("pre").textContent(), "const done = true;\nreturn done;");
    assert.equal(await editor.locator("blockquote").textContent(), "at 10:30 👍");
    assert.equal(await page.getByTestId("emoji-menu").count(), 0, "10:30 must not open the : menu");

    await page.keyboard.press("Enter");
    const message = page.getByTestId("sent-message").first();
    await message.waitFor();
    assert.equal(
      await message.getByTestId("sent-source").textContent(),
      "Plan for 🎉\n\n- **ship** it\n- test it\n\n```\nconst done = true;\nreturn done;\n```\n\n> at 10:30 👍",
    );
    const rendered = message.locator(".md-content");
    assert.equal(await rendered.locator("ul > li").count(), 2);
    assert.equal(await rendered.locator("li strong").textContent(), "ship");
    assert.match(await rendered.locator("pre code").textContent(), /const done = true;\nreturn done;/);
    assert.equal((await rendered.locator("blockquote").textContent()).trim(), "at 10:30 👍");
    assert.equal(await editor.textContent(), "");
    assert.deepEqual(errors, []);
  });

  test(`${engine.name()}: selection toolbar and mouse picks round-trip through a send`, async (t) => {
    const { page, editor, errors } = await openComposer(engine, t);
    const toolbar = page.getByTestId("selection-toolbar");
    const selectLeft = async (count) => {
      for (let i = 0; i < count; i++) await page.keyboard.press("Shift+ArrowLeft");
    };

    await page.keyboard.type("Ship it today");
    await selectLeft(5);
    await toolbar.getByRole("button", { name: "Bold" }).click();
    assert.equal(await editor.locator("strong").textContent(), "today");

    // Link: the URL is typed into the toolbar; Escape cancels without a change.
    await page.keyboard.press("End");
    await page.keyboard.press("Home");
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight");
    await toolbar.getByRole("button", { name: "Link" }).click();
    const url = toolbar.getByRole("textbox", { name: "Link URL" });
    await url.waitFor();
    await url.press("Escape");
    assert.equal(await url.count(), 0);
    assert.equal(await editor.textContent(), "Ship it today");
    await toolbar.getByRole("button", { name: "Link" }).click();
    await url.fill("https://example.com/ship?sig=a%2Fb&x=1");
    await url.press("Enter");
    assert.equal(await editor.textContent(), "[Ship](https://example.com/ship?sig=a%2Fb&x=1) it today");

    // The : and # menus by mouse. Text typed after the bold word stays bold.
    await page.keyboard.press("End");
    await page.keyboard.type(" :hear");
    await page.getByTestId("emoji-menu").locator('[data-suggestion-option="heart"]').click();
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("#quo");
    await page.getByTestId("block-menu").getByRole("option", { name: /Quote/ }).click();
    await page.keyboard.type("quoted");
    assert.equal(await editor.locator("blockquote").textContent(), "quoted");

    await page.keyboard.press("Enter");
    const message = page.getByTestId("sent-message").first();
    await message.waitFor();
    assert.equal(
      await message.getByTestId("sent-source").textContent(),
      "[Ship](https://example.com/ship?sig=a%2Fb&x=1) it **today ❤️**\n\n> quoted",
    );
    const rendered = message.locator(".md-content");
    assert.equal(await rendered.locator("a").getAttribute("href"), "https://example.com/ship?sig=a%2Fb&x=1");
    assert.equal(await rendered.locator("a").textContent(), "Ship");
    assert.equal(await rendered.locator("strong").textContent(), "today ❤️");
    assert.equal((await rendered.locator("blockquote").textContent()).trim(), "quoted");
    assert.deepEqual(errors, []);
  });
}
