import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmojiImage } from "./EmojiImage";

describe("EmojiImage", () => {
  it("keeps a native glyph visible while the bundled sprite loads", async () => {
    const { container } = render(<EmojiImage emoji="👍" size={20} />);

    const loadingFallback = screen.getByText("👍");
    expect(loadingFallback).toHaveAttribute("data-emoji-loading");
    const loader = container.querySelector<HTMLImageElement>(
      "img[data-emoji-sprite-loader]",
    );
    expect(loader).not.toBeNull();

    fireEvent.load(loader!);

    await waitFor(() => {
      const image = container.querySelector<HTMLElement>("[data-emoji-image]");
      expect(image).not.toBeNull();
      expect(image).toHaveAttribute("aria-hidden", "true");
      expect(image).toHaveStyle({
        width: "20px",
        height: "20px",
        backgroundRepeat: "no-repeat",
      });
      expect(image?.style.backgroundImage).toMatch(/^url\(/);
      expect(image?.style.backgroundImage).not.toContain("http");
      expect(image?.textContent).toBe("");
    });
  });

  it.each(["❤️", "👍🏽", "👩‍💻", "🇨🇭", "1️⃣", "🏃🏻‍♀"])(
    "maps the complete Unicode sequence for %s to an image cell",
    (emoji) => {
      const { container } = render(<EmojiImage emoji={emoji} size={18} />);
      expect(container.querySelector("[data-emoji-image]")).not.toBeNull();
      expect(container.querySelector("[data-emoji-fallback]")).toBeNull();
    },
  );

  it("uses distinct sprite cells for variation selectors and skin tones", () => {
    const { container, rerender } = render(
      <EmojiImage emoji="❤️" size={18} />,
    );
    const heartPosition = container.querySelector<HTMLElement>(
      "[data-emoji-image]",
    )?.style.backgroundPosition;

    rerender(<EmojiImage emoji="👍🏽" size={18} />);
    const skinTonePosition = container.querySelector<HTMLElement>(
      "[data-emoji-image]",
    )?.style.backgroundPosition;

    expect(heartPosition).toBeTruthy();
    expect(skinTonePosition).toBeTruthy();
    expect(skinTonePosition).not.toBe(heartPosition);
  });

  it("falls back to the native glyph when the image set has no entry", () => {
    render(<EmojiImage emoji="not-an-emoji" size={20} />);

    const fallback = screen.getByText("not-an-emoji");
    expect(fallback).toHaveAttribute("data-emoji-fallback");
    expect(fallback).toHaveAttribute("aria-hidden", "true");
    expect(
      fallback.querySelector("img[data-emoji-sprite-loader]"),
    ).toBeNull();
  });
});
