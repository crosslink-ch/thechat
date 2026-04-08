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
});
