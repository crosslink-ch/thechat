import { beforeEach, describe, expect, test, vi } from "vitest";

const { close, connectDirectHermesGateway, request } = vi.hoisted(() => ({
  close: vi.fn(),
  connectDirectHermesGateway: vi.fn(),
  request: vi.fn(),
}));

vi.mock("./direct-hermes-gateway", () => ({
  connectDirectHermesGateway,
}));

import { listDirectHermesSessions } from "./direct-hermes-sessions";

describe("Direct Hermes session application adapter", () => {
  beforeEach(() => {
    close.mockReset();
    request.mockReset();
    connectDirectHermesGateway.mockReset();
    connectDirectHermesGateway.mockResolvedValue({ close, request });
  });

  test("constructs session.list in the desktop and normalizes its result", async () => {
    request.mockResolvedValue({
      sessions: [
        {
          id: "session-1",
          resolved_id: "resolved-1",
          title: "Architecture",
          preview: "Continue",
          started_at: 123,
          message_count: 4,
          source: "thechat",
        },
      ],
    });

    const issueTicket = vi.fn();
    await expect(listDirectHermesSessions({ issueTicket })).resolves.toEqual([
      {
        id: "session-1",
        resolvedId: "resolved-1",
        title: "Architecture",
        preview: "Continue",
        startedAt: 123,
        messageCount: 4,
        source: "thechat",
      },
    ]);
    expect(request).toHaveBeenCalledWith("session.list", { limit: 200 });
    expect(close).toHaveBeenCalledOnce();
  });

  test("rejects malformed Hermes results and still closes the client", async () => {
    request.mockResolvedValue({ sessions: [{ id: 42 }] });

    await expect(
      listDirectHermesSessions({ issueTicket: vi.fn() }),
    ).rejects.toThrow("Hermes session.list returned an invalid result");
    expect(close).toHaveBeenCalledOnce();
  });

  test("does not mint a ticket when the session load is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      listDirectHermesSessions({
        issueTicket: vi.fn(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(connectDirectHermesGateway).not.toHaveBeenCalled();
  });
});
