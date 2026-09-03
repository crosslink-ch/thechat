import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sessionsGet } = vi.hoisted(() => ({ sessionsGet: vi.fn() }));

vi.mock("../lib/api", () => ({
  api: {
    bots: () => ({
      "hermes-rpc": { sessions: { get: sessionsGet } },
    }),
  },
}));

import { DirectHermesSessionsView } from "./DirectHermesSessionsView";

function renderView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DirectHermesSessionsView
        botId="bot-1"
        botName="Direct Hermes"
        token="thechat-user-token"
      />
    </QueryClientProvider>,
  );
}

describe("DirectHermesSessionsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionsGet.mockResolvedValue({
      data: {
        sessions: [
          {
            id: "session-1",
            resolvedId: null,
            title: "Proxy proof",
            preview: "Listed through session.list",
            startedAt: 1_788_000_000,
            messageCount: 7,
            source: "thechat",
          },
        ],
      },
      error: null,
    });
  });

  it("loads and displays the proxied Hermes session list", async () => {
    renderView();

    expect(await screen.findByRole("heading", { name: "Proxy proof" })).toBeInTheDocument();
    expect(screen.getByText("session-1")).toBeInTheDocument();
    expect(screen.getByText("Listed through session.list")).toBeInTheDocument();
    expect(screen.getByText("7 messages")).toBeInTheDocument();
    expect(sessionsGet).toHaveBeenCalledWith({
      headers: { authorization: "Bearer thechat-user-token" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(sessionsGet).toHaveBeenCalledTimes(2));
  });
});
