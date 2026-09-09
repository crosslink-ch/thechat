import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MessageReactions } from "./MessageReactions";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("MessageReactions", () => {
  it("opens an emoji picker and adds the selected reaction", async () => {
    const onSetReaction = vi.fn().mockResolvedValue(undefined);
    render(<MessageReactions reactions={[]} onSetReaction={onSetReaction} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add reaction" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(
      screen.getByRole("menu", { name: "Choose a reaction" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "React with 👍" }));

    await waitFor(() => {
      expect(onSetReaction).toHaveBeenCalledWith("👍", true);
    });
    expect(
      screen.queryByRole("menu", { name: "Choose a reaction" }),
    ).not.toBeInTheDocument();
  });

  it("shows grouped reactions and toggles the current user's reaction off", async () => {
    const onSetReaction = vi.fn().mockResolvedValue(undefined);
    render(
      <MessageReactions
        reactions={[
          {
            emoji: "👍",
            count: 2,
            reactedByMe: true,
            userNames: ["Alice", "Bob"],
          },
        ]}
        onSetReaction={onSetReaction}
      />,
    );

    const reaction = screen.getByRole("button", { name: "👍 2 reactions" });
    expect(reaction).toHaveAttribute("aria-pressed", "true");
    expect(reaction).toHaveAttribute("title", "Alice and Bob reacted with 👍");

    fireEvent.click(reaction);

    await waitFor(() => {
      expect(onSetReaction).toHaveBeenCalledWith("👍", false);
    });
  });

  it("uses image-backed emoji in reaction chips and picker choices", async () => {
    const onSetReaction = vi.fn().mockResolvedValue(undefined);
    render(
      <MessageReactions
        reactions={[
          {
            emoji: "👍",
            count: 1,
            reactedByMe: false,
            userNames: ["Alice"],
          },
        ]}
        onSetReaction={onSetReaction}
      />,
    );

    const reaction = screen.getByRole("button", { name: "👍 1 reaction" });
    const loader = reaction.querySelector<HTMLImageElement>(
      "img[data-emoji-sprite-loader]",
    );
    if (loader) fireEvent.load(loader);
    await waitFor(() => {
      expect(reaction.querySelector("[data-emoji-image]")).not.toBeNull();
    });
    expect(reaction).not.toHaveTextContent("👍");

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add reaction" }), {
      button: 0,
      ctrlKey: false,
    });
    const pickerChoice = screen.getByRole("menuitem", { name: "React with 👍" });
    expect(pickerChoice.querySelector("[data-emoji-image]")).not.toBeNull();
    expect(pickerChoice).not.toHaveTextContent("👍");
  });

  it("shows mutation failures without collapsing the error message", async () => {
    const onSetReaction = vi.fn().mockRejectedValue(new Error("Network unavailable"));
    render(<MessageReactions reactions={[]} onSetReaction={onSetReaction} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add reaction" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "React with 👍" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Network unavailable");
    expect(alert.parentElement).toHaveClass("min-h-7");
  });
});
