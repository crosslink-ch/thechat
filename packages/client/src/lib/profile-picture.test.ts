import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROFILE_PICTURE_OUTPUT_BYTES,
  MAX_PROFILE_PICTURE_SOURCE_BYTES,
  prepareProfilePicture,
} from "./profile-picture";

describe("prepareProfilePicture", () => {
  const originalImage = globalThis.Image;

  afterEach(() => {
    globalThis.Image = originalImage;
    vi.restoreAllMocks();
  });

  function installImagePipeline(output: Blob) {
    const canvases: Array<{
      width: number;
      height: number;
      context: { fillRect: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn> };
    }> = [];
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:profile-picture");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    class TestImage {
      naturalWidth = 800;
      naturalHeight = 400;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    globalThis.Image = TestImage as unknown as typeof Image;

    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      if (tagName !== "canvas") return originalCreateElement(tagName);
      const context = { fillRect: vi.fn(), drawImage: vi.fn() };
      const canvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => context),
        toBlob: vi.fn((callback: BlobCallback) => callback(output)),
      };
      canvases.push({
        get width() {
          return canvas.width;
        },
        get height() {
          return canvas.height;
        },
        context,
      });
      return canvas as unknown as HTMLCanvasElement;
    }) as typeof document.createElement);
    return canvases;
  }

  it("normalizes a selected raster to a bounded JPEG data URL", async () => {
    const canvases = installImagePipeline(
      new Blob(["compressed portrait"], { type: "image/jpeg" }),
    );
    const file = new File(["source"], "portrait.png", { type: "image/png" });

    const result = await prepareProfilePicture(file);

    expect(result).toMatch(/^data:image\/jpeg;base64,/);
    expect(canvases[0]).toMatchObject({ width: 256, height: 128 });
    expect(canvases[0]?.context.fillRect).toHaveBeenCalledWith(0, 0, 256, 128);
    expect(canvases[0]?.context.drawImage).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:profile-picture");
  });

  it("rejects unsupported and excessively large source files", async () => {
    await expect(
      prepareProfilePicture(
        new File(["<svg/>"] , "portrait.svg", { type: "image/svg+xml" }),
      ),
    ).rejects.toThrow("PNG, JPEG, or WebP");

    await expect(
      prepareProfilePicture(
        new File(
          [new Uint8Array(MAX_PROFILE_PICTURE_SOURCE_BYTES + 1)],
          "portrait.png",
          { type: "image/png" },
        ),
      ),
    ).rejects.toThrow("10 MB or smaller");
  });

  it("rejects a processed image that cannot meet the stored byte budget", async () => {
    installImagePipeline(
      new Blob([new Uint8Array(MAX_PROFILE_PICTURE_OUTPUT_BYTES + 1)], {
        type: "image/jpeg",
      }),
    );

    await expect(
      prepareProfilePicture(
        new File(["source"], "portrait.webp", { type: "image/webp" }),
      ),
    ).rejects.toThrow("could not be compressed below 128 KB");
  });
});
