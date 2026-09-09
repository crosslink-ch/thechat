import { describe, expect, it } from "vitest";
import { resolveShippedReleaseVersion, releaseNotesCatalog, shippedReleaseVersion } from "./release-notes";

const catalog = [{ version: "0.9.0" }, { version: "0.8.0" }];
describe("bundled shipped version", () => {
  it("uses the installed desktop version even when the catalog contains newer notes", () => {
    expect(resolveShippedReleaseVersion(false, "0.8.0", catalog)).toBe("0.8.0");
    expect(resolveShippedReleaseVersion(false, "0.0.0-dev", catalog)).toBe("0.0.0-dev");
  });
  it("uses the latest bundled catalog for web and is honest about an empty catalog", () => {
    expect(resolveShippedReleaseVersion(true, "0.0.0-dev", catalog)).toBe("0.9.0");
    expect(resolveShippedReleaseVersion(true, "", [])).toBe("unknown");
  });
  it("loads the real root catalog without a native runtime API", () => {
    expect(releaseNotesCatalog[0].version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(releaseNotesCatalog[0].body.trim()).not.toBe("");
    expect(shippedReleaseVersion).toBe(__DESKTOP_RELEASE_VERSION__);
  });
});
