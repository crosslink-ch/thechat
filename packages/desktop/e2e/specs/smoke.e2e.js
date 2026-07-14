describe("Smoke test", () => {
  it("should launch the app and render the React root", async () => {
    // #root is mounted by main.tsx — once it has children, React has booted
    // and rendered the app. This is a minimal end-to-end check that the
    // Tauri binary launches, the webview loads the bundled frontend, and the
    // JS bundle executes successfully.
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
        ),
      { timeout: 15000, timeoutMsg: "React never mounted children into #root" },
    );

    // Confirm the document title from index.html is set — proves the webview
    // is showing our HTML, not a blank/error page.
    const documentTitle = await browser.execute(() => document.title);
    expect(documentTitle).toBe("TheChat");
  });

  it("should contain scrolling within the app viewport", async () => {
    const result = await browser.execute(() => {
      const root = document.getElementById("root");
      if (!root) throw new Error("React root is missing");

      const shellStyles = [document.documentElement, document.body, root].map(
        (element) => {
          const style = getComputedStyle(element);
          return {
            clientHeight: element.clientHeight,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            overscrollBehaviorX: style.overscrollBehaviorX,
            overscrollBehaviorY: style.overscrollBehaviorY,
          };
        },
      );

      // A bounded descendant verifies that root containment does not disable
      // the app's intended nested scroll regions.
      const nestedScroller = document.createElement("div");
      nestedScroller.style.cssText =
        "position:fixed;top:0;left:0;width:10px;height:10px;overflow-y:auto;opacity:0;pointer-events:none";
      const nestedContent = document.createElement("div");
      nestedContent.style.cssText = "width:10px;height:40px";
      nestedScroller.appendChild(nestedContent);
      root.appendChild(nestedScroller);
      // Force layout before setting scrollTop so WebKit creates the scroll box.
      void nestedScroller.offsetHeight;
      nestedScroller.scrollTop = 8;

      const nestedResult = {
        overflowY: getComputedStyle(nestedScroller).overflowY,
        scrollTop: nestedScroller.scrollTop,
      };
      nestedScroller.remove();

      return { viewportHeight: window.innerHeight, shellStyles, nestedResult };
    });

    for (const style of result.shellStyles) {
      expect(style).toEqual({
        clientHeight: result.viewportHeight,
        overflowX: "hidden",
        overflowY: "hidden",
        overscrollBehaviorX: "none",
        overscrollBehaviorY: "none",
      });
    }
    expect(result.nestedResult).toEqual({ overflowY: "auto", scrollTop: 8 });
  });
});
