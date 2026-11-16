import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, webkit } from "playwright";
import { startViteServer } from "./support/vite-server.mjs";

let server;
let baseUrl;
before(async () => {
  server = await startViteServer({ entries: ["browser-tests/fixtures/chat.html"] });
  baseUrl = server.baseUrl;
});
after(async () => { await server?.close(); });

const settle = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}));
const gap = (scroller) => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
// Grows the newest message like a late image or formatting would (its content
// box, which is what the app's resize observer watches).
const GROW = `(el, height) => {
  const rows = el.querySelectorAll("[data-message-id]");
  const body = rows[rows.length - 1].lastElementChild;
  let block = body.querySelector("[data-test-growth]");
  if (!block) {
    block = document.createElement("div");
    block.dataset.testGrowth = "";
    body.append(block);
  }
  block.style.height = height + "px";
}`;

// The chat follows the newest message through layout changes. A scroll event
// can reach the page after a resize but before the resize observer has seen
// it: here, the event from following a grown message, delivered in the frame
// where the phone keyboard (or a window resize) shrinks the message list. That
// event reads the resize's gap, which is not the user scrolling away.
for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
  test(`${engineName}: the chat keeps following the newest message through a resize`, async (t) => {
    const browser = await engine.launch();
    t.after(() => browser.close());
    for (const view of ["channel", "hermes"]) {
      await t.test(view, async () => {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        try {
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`${baseUrl}/browser-tests/fixtures/chat.html?view=${view}`);
          const scroller = page.getByTestId(view === "channel" ? "channel-chat-scroll" : "hermes-dm-chat-scroll");
          await page.locator(".ProseMirror").waitFor();
          await page.evaluate(() => document.fonts.ready);
          await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
          await settle(page);
          assert.ok(await gap(scroller) <= 1, "starts at the newest message");

          // Newest message grows and the chat follows it; in the same frame the
          // list becomes 300px shorter.
          await scroller.evaluate((el, grow) => {
            (0, eval)(grow)(el, 120);
            el.scrollTop = el.scrollHeight;
            el.style.maxHeight = `${el.clientHeight - 300}px`;
          }, GROW);
          await settle(page);
          assert.ok(await gap(scroller) <= 1, `resize moved the chat away from the newest message: gap ${await gap(scroller)}`);

          // It still follows afterwards.
          await scroller.evaluate((el, grow) => (0, eval)(grow)(el, 240), GROW);
          await settle(page);
          assert.ok(await gap(scroller) <= 1, `stopped following: gap ${await gap(scroller)}`);

          // Scrolling up in the same frame as a resize still counts as the user's.
          await scroller.evaluate((el) => {
            el.scrollTop -= 400;
            el.style.maxHeight = `${el.clientHeight - 100}px`;
          });
          await settle(page);
          const reading = await gap(scroller);
          assert.ok(reading > 300, `scrolling up was undone: gap ${reading}`);
          await scroller.evaluate((el, grow) => (0, eval)(grow)(el, 360), GROW);
          await settle(page);
          assert.ok(await gap(scroller) > 300, "a new message must not pull the reader down");

          // Sending while reading older history: the message is added and the
          // chat jumps to it in the same frame. It must stay there.
          await scroller.evaluate((el, grow) => {
            (0, eval)(grow)(el, 480);
            el.scrollTop = el.scrollHeight;
          }, GROW);
          await settle(page);
          assert.ok(await gap(scroller) <= 1, `the jump to the newest message was undone: gap ${await gap(scroller)}`);
          await scroller.evaluate((el, grow) => (0, eval)(grow)(el, 520), GROW);
          await settle(page);
          assert.ok(await gap(scroller) <= 1, `stopped following after the jump: gap ${await gap(scroller)}`);

          // Content shrinks and the list grows (a wider window): the browser
          // clamps the position upwards, which is not the user scrolling up.
          // Reading layout right away queues that scroll event before the
          // resize observer runs.
          await scroller.evaluate((el, grow) => {
            (0, eval)(grow)(el, 0);
            el.style.maxHeight = "";
            void el.scrollTop;
          }, GROW);
          await settle(page);
          assert.ok(await gap(scroller) <= 1, `a clamp after the content shrank moved the chat up: gap ${await gap(scroller)}`);
          await scroller.evaluate((el, grow) => (0, eval)(grow)(el, 200), GROW);
          await settle(page);
          assert.ok(await gap(scroller) <= 1, `stopped following after the clamp: gap ${await gap(scroller)}`);
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    }
  });
}
