import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UserAvatar } from "./UserAvatar";

describe("UserAvatar", () => {
  it("renders the saved profile picture with accessible text", () => {
    render(
      <UserAvatar
        name="Jane Rivera"
        avatar="data:image/jpeg;base64,cHJvZmlsZQ=="
        size="lg"
      />,
    );

    const image = screen.getByRole("img", { name: "Jane Rivera profile picture" });
    expect(image).toHaveAttribute(
      "src",
      "data:image/jpeg;base64,cHJvZmlsZQ==",
    );
    expect(image.parentElement).toHaveClass("h-10", "w-10");
  });

  it("falls back to initials when no picture exists or an image fails", () => {
    const { rerender } = render(
      <UserAvatar name="Jane Rivera" avatar={null} />,
    );
    expect(
      screen.getByRole("img", { name: "Jane Rivera profile picture" }),
    ).toHaveTextContent("JR");

    rerender(
      <UserAvatar
        name="Jane Rivera"
        avatar="data:image/jpeg;base64,broken"
      />,
    );
    fireEvent.error(
      screen.getByRole("img", { name: "Jane Rivera profile picture" }),
    );
    expect(
      screen.getByRole("img", { name: "Jane Rivera profile picture" }),
    ).toHaveTextContent("JR");
  });
});
