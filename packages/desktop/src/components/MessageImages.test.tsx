import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadImageBase64 } from "../lib/images";
import { MessageImages } from "./MessageImages";

vi.mock("../lib/images", () => ({
  loadImageBase64: vi.fn(),
}));

describe("MessageImages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps one fixed thumbnail frame while a local image loads", async () => {
    let finishLoading: ((base64: string) => void) | undefined;
    vi.mocked(loadImageBase64).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoading = resolve;
        }),
    );

    render(
      <MessageImages
        images={[{ path: "/tmp/diagram.png", mimeType: "image/png" }]}
      />,
    );

    const frame = screen.getByTestId("message-image-frame");
    expect(frame).toHaveClass("aspect-[5/3]", "w-80", "max-w-full");
    expect(frame.querySelector("img")).not.toBeInTheDocument();

    await act(async () => {
      finishLoading?.("aW1hZ2U=");
    });
    await waitFor(() => expect(frame.querySelector("img")).toBeInTheDocument());

    expect(screen.getByTestId("message-image-frame")).toBe(frame);
    expect(frame).toHaveClass("aspect-[5/3]", "w-80", "max-w-full");
    expect(frame.querySelector("img")).toHaveClass("h-full", "w-full");
  });
});
