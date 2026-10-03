import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BOT_AVATAR_SHAPES, PLAYFUL_BOT_AVATAR_SHAPES } from "@thechat/shared";
import { Avatar } from "./Avatar";
import { BotFace } from "./BotFace";

const ghost = { shape: "ghost", color: "#3498DB" } as const;

describe("BotFace", () => {
  it("keeps the playful pool exactly aligned with the library's shapes", async () => {
    const library =
      await vi.importActual<typeof import("bot-avatars")>("bot-avatars");
    expect([...PLAYFUL_BOT_AVATAR_SHAPES]).toEqual([...library.botAvatarTypes]);
    expect([...BOT_AVATAR_SHAPES]).toEqual([...library.botAvatarTypes, "minimal"]);
  });

  it("renders Minimal as the same inert geometric glyph in every motion state", () => {
    const appearance = { shape: "minimal", color: "#00B894" } as const;
    const { container, rerender } = render(<BotFace appearance={appearance} size={32} />);
    const glyph = container.querySelector("[data-bot-minimal]");
    expect(glyph).not.toBeNull();
    const drawing = glyph!.innerHTML;
    for (const motion of ["still", "idle", "live", "working", "sleeping"] as const) {
      rerender(<BotFace appearance={appearance} size={32} motion={motion} />);
      expect(container.querySelector("[data-bot-minimal]")!.innerHTML).toBe(drawing);
      // Orbit's SVG geometry is static artwork, not an animation signal.
      expect(container.querySelector("[data-bot-avatar], canvas, animate, animateTransform")).toBeNull();
      expect(glyph).toHaveAttribute("aria-hidden", "true");
      expect(glyph).toHaveAttribute("width", "32");
      expect(glyph).toHaveStyle({ color: "#00B894" });
    }
  });

  it("maps each motion onto the library's state, pause and pointer play", async () => {
    const cases = [
      ["still", "default", "true", "false"],
      ["idle", "default", "false", "false"],
      ["live", "default", "false", "true"],
      ["working", "working", "false", "false"],
      ["sleeping", "sleeping", "true", "false"],
    ] as const;
    for (const [motion, state, paused, interactive] of cases) {
      const { container, unmount } = render(
        <BotFace appearance={ghost} size={32} motion={motion} />,
      );
      const bot = await waitFor(() => {
        const found = container.querySelector("[data-bot-avatar]");
        expect(found).not.toBeNull();
        return found!;
      });
      expect(bot).toHaveAttribute("data-bot-avatar", "ghost");
      expect(bot).toHaveAttribute("data-color", "#3498DB");
      expect(bot).toHaveAttribute("data-state", state);
      expect(bot).toHaveAttribute("data-paused", paused);
      expect(bot).toHaveAttribute("data-interactive", interactive);
      unmount();
    }
  });

  it("starts a stopped bot at rest instead of freezing its last frame", async () => {
    const { container, rerender } = render(
      <BotFace appearance={ghost} size={32} motion="working" />,
    );
    const working = await waitFor(() => {
      const found = container.querySelector("[data-bot-avatar]");
      expect(found).not.toBeNull();
      return found!;
    });

    rerender(<BotFace appearance={ghost} size={32} motion="still" />);
    const still = container.querySelector("[data-bot-avatar]");
    expect(still).toHaveAttribute("data-paused", "true");
    // A new instance, so it draws its resting pose rather than the mid-hop one.
    expect(still).not.toBe(working);
  });
});

describe("Avatar", () => {
  it("draws a bot's shape instead of its initial", async () => {
    const { container } = render(
      <Avatar name="Koda" bot botAvatar={ghost} size={32} />,
    );
    await waitFor(() =>
      expect(container.querySelector("[data-bot-avatar]")).toHaveAttribute(
        "data-bot-avatar",
        "ghost",
      ),
    );
    expect(container).not.toHaveTextContent("K");
  });

  it("keeps the initial for people and for bots without an appearance", () => {
    const { container, rerender } = render(<Avatar name="Ada" />);
    expect(container).toHaveTextContent("A");
    expect(container.querySelector("[data-bot-avatar]")).toBeNull();

    rerender(<Avatar name="Koda" bot />);
    expect(container).toHaveTextContent("K");
    expect(container.querySelector("[data-bot-avatar]")).toBeNull();
  });
});
