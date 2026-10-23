import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { api } from "../lib/api";
import { wsEvents } from "../lib/ws-events";
import { createQueryWrapper } from "../test-utils/query";
import { useTaskProjects } from "./useTaskProjects";

vi.mock("../lib/api", () => ({
  api: {
    conversations: {
      projects: vi.fn(),
    },
  },
}));

// Eden Treaty revives ISO timestamps in JSON responses as Date objects.
const wireProject = (id: string, name: string, at: string) => ({
  id,
  conversationId: "dm-1",
  name,
  createdById: "user-1",
  createdAt: new Date(at),
  updatedAt: new Date(at),
});

describe("useTaskProjects", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates a project when the API returns Date timestamps", async () => {
    const get = vi.fn(() =>
      Promise.resolve({
        data: [wireProject("p-1", "Launch", "2026-10-01T09:00:00.000Z")],
      }),
    );
    const post = vi.fn(() =>
      Promise.resolve({
        data: wireProject("p-2", "Security", "2026-10-23T09:00:00.000Z"),
      }),
    );
    vi.mocked(api.conversations.projects).mockReturnValue({ get, post } as any);

    const { result } = renderHook(
      () => useTaskProjects("dm-1", "test-token", true),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.projects.map((project) => project.name)).toEqual(["Launch"]);
    });

    let created: Awaited<ReturnType<typeof result.current.createProject>> = null;
    await act(async () => {
      created = await result.current.createProject("Security");
    });

    expect(created).toMatchObject({
      id: "p-2",
      createdAt: "2026-10-23T09:00:00.000Z",
      updatedAt: "2026-10-23T09:00:00.000Z",
    });
    await waitFor(() => {
      expect(result.current.projects.map((project) => project.name)).toEqual([
        "Launch",
        "Security",
      ]);
    });
    for (const project of result.current.projects) {
      expect(typeof project.createdAt).toBe("string");
      expect(typeof project.updatedAt).toBe("string");
    }
  });

  it("orders projects by creation time across REST and WebSocket updates", async () => {
    const get = vi.fn(() =>
      Promise.resolve({
        data: [wireProject("p-2", "Later", "2026-10-02T09:00:00.000Z")],
      }),
    );
    vi.mocked(api.conversations.projects).mockReturnValue({ get } as any);

    const { result } = renderHook(
      () => useTaskProjects("dm-1", "test-token", true),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => {
      expect(result.current.projects).toHaveLength(1);
    });

    act(() => {
      wsEvents.emit("ws:task_project_updated", {
        conversationId: "dm-1",
        project: {
          id: "p-1",
          conversationId: "dm-1",
          name: "Earlier",
          createdById: "user-1",
          createdAt: "2026-10-01T09:00:00.000Z",
          updatedAt: "2026-10-01T09:00:00.000Z",
        },
      });
    });

    await waitFor(() => {
      expect(result.current.projects.map((project) => project.name)).toEqual([
        "Earlier",
        "Later",
      ]);
    });
  });
});
