import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScrollDebugRoute } from "./scroll-debug";

// Rendering the whole debug route (80+ LaTeX-heavy messages) takes the
// interactive tests 2-3 s when idle and over Vitest's 5 s default under load.
describe("ScrollDebugRoute", { timeout: 20_000 }, () => {
  it("renders generated Hermes history and debug controls", () => {
    render(<ScrollDebugRoute />);

    expect(screen.getByText("Scroll Debug")).toBeInTheDocument();
    expect(screen.getAllByText("General").length).toBeGreaterThan(0);
    expect(screen.getByText("Hermes DM")).toBeInTheDocument();
    expect(screen.getByText("Append 10")).toBeInTheDocument();
    expect(screen.getByText("LaTeX-heavy message 260", { exact: false })).toBeInTheDocument();
  });

  it("can load older generated messages from the control panel", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<ScrollDebugRoute />);

    try {
      expect(screen.queryByText("LaTeX-heavy message 180", { exact: false })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Load older" }));
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      expect(screen.getByText("LaTeX-heavy message 180", { exact: false })).toBeInTheDocument();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("can switch to the channel scroll surface", async () => {
    render(<ScrollDebugRoute />);

    fireEvent.click(screen.getByRole("button", { name: "Channel" }));

    await waitFor(() => {
      expect(screen.getByTestId("channel-chat-scroll")).toBeInTheDocument();
    });
  });
});
