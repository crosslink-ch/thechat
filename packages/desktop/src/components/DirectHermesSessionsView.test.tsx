import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listDirectHermesSessions, proxyTicketPost } = vi.hoisted(() => ({
  listDirectHermesSessions: vi.fn(),
  proxyTicketPost: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    bots: () => ({
      "hermes-rpc": { "proxy-ticket": { post: proxyTicketPost } },
    }),
  },
}));

vi.mock("../lib/direct-hermes-sessions", () => ({
  listDirectHermesSessions,
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
        conversationId="conversation-1"
        token="thechat-user-token"
      />
    </QueryClientProvider>,
  );
}

describe("DirectHermesSessionsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    proxyTicketPost.mockResolvedValue({
      data: {
        proxyUrl: "wss://api.example.test/hermes-proxy",
        ticket: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        expiresAt: "2026-09-03T12:00:30.000Z",
      },
      error: null,
    });
    listDirectHermesSessions.mockImplementation(
      async ({ issueTicket, signal }) => {
        await issueTicket(signal);
        return [
          {
            id: "session-1",
            resolvedId: null,
            title: "Proxy proof",
            preview: "Listed directly through session.list",
            startedAt: 1_788_000_000,
            messageCount: 7,
            source: "thechat",
          },
        ];
      },
    );
  });

  it("runs session.list in the desktop through a permission-gated proxy", async () => {
    renderView();

    expect(
      await screen.findByRole("heading", { name: "Proxy proof" }),
    ).toBeInTheDocument();
    expect(screen.getByText("session-1")).toBeInTheDocument();
    expect(
      screen.getByText("Listed directly through session.list"),
    ).toBeInTheDocument();
    expect(screen.getByText("7 messages")).toBeInTheDocument();
    expect(proxyTicketPost).toHaveBeenCalledWith(
      { conversationId: "conversation-1" },
      {
        fetch: { signal: expect.any(AbortSignal) },
        headers: { authorization: "Bearer thechat-user-token" },
      },
    );
    expect(listDirectHermesSessions).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(listDirectHermesSessions).toHaveBeenCalledTimes(2)
    );
    expect(proxyTicketPost).toHaveBeenCalledTimes(2);
  });

  it("aborts the Hermes connection when the view unmounts", async () => {
    let signal: AbortSignal | undefined;
    listDirectHermesSessions.mockImplementation(
      ({ signal: querySignal }) => {
        signal = querySignal;
        return new Promise(() => {});
      },
    );

    const view = renderView();
    await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
    expect(signal?.aborted).toBe(false);

    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
