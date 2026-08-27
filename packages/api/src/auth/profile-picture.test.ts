import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  MAX_PROFILE_PICTURE_BYTES,
  normalizeProfilePicture,
  ProfilePictureValidationError,
} from "./profile-picture";

function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function dataUrl(mediaType: string, bytes: Uint8Array) {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

const completeRasters = [
  [
    "image/png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  ],
  [
    "image/jpeg",
    "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z",
  ],
  [
    "image/webp",
    "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=",
  ],
] as const;

describe("profile picture validation", () => {
  test.each(completeRasters)(
    "accepts a complete %s raster",
    async (mediaType, encoded) => {
      const value = dataUrl(mediaType, Buffer.from(encoded, "base64"));
      expect(await normalizeProfilePicture(value)).toBe(value);
    },
  );

  test("accepts removal", async () => {
    await expect(normalizeProfilePicture(null)).resolves.toBeNull();
  });

  test("rejects animated profile pictures", async () => {
    const frames = await Promise.all(
      [
        { r: 0, g: 0, b: 0 },
        { r: 255, g: 255, b: 255 },
      ].map((background) =>
        sharp({
          create: {
            width: 2,
            height: 2,
            channels: 3,
            background,
          },
        })
          .png()
          .toBuffer(),
      ),
    );
    const animatedWebp = await sharp(frames, { join: { animated: true } })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(animatedWebp).metadata()).pages).toBe(2);

    await expect(
      normalizeProfilePicture(dataUrl("image/webp", animatedWebp)),
    ).rejects.toThrow("single frame");
  });

  test("rejects active, malformed, spoofed, and unsupported image payloads", async () => {
    for (const value of [
      "https://tracker.example/avatar.png",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:image/png;base64,not!base64",
      dataUrl("image/jpeg", pngHeader(64, 64)),
      dataUrl("image/png", pngHeader(64, 64)),
      dataUrl("image/png", new TextEncoder().encode("not an image")),
    ]) {
      await expect(normalizeProfilePicture(value)).rejects.toBeInstanceOf(
        ProfilePictureValidationError,
      );
    }
  });

  test("rejects images that exceed the byte or dimension budget", async () => {
    await expect(
      normalizeProfilePicture(
        dataUrl("image/png", new Uint8Array(MAX_PROFILE_PICTURE_BYTES + 1)),
      ),
    ).rejects.toThrow("128 KB or smaller");
    const oversizedDimensions = await sharp({
      create: {
        width: 1025,
        height: 256,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    await expect(
      normalizeProfilePicture(dataUrl("image/png", oversizedDimensions)),
    ).rejects.toThrow("1024 by 1024 pixels or smaller");
  });
});
