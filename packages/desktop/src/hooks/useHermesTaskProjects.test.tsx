import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useHermesTaskProjects } from "./useHermesTaskProjects";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const scope = { userId: "user-a", conversationId: "conversation-a" };
const project = {
  id: "project-a",
  name: "Website refresh",
  color: "violet" as const,
  position: 0,
  createdAt: "2026-08-25T12:00:00Z",
  updatedAt: "2026-08-25T12:00:00Z",
};

describe("useHermesTaskProjects", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("loads projects and assignments from local Tauri SQLite commands", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "list_hermes_task_projects") return [project];
      if (command === "list_hermes_task_project_assignments") {
        return [{ threadId: "thread-a", projectId: "project-a" }];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const { result } = renderHook(() => useHermesTaskProjects(scope));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.projects).toEqual([project]);
    expect(result.current.assignments).toEqual({ "thread-a": "project-a" });
    expect(invokeMock).toHaveBeenCalledWith("list_hermes_task_projects", scope);
    expect(invokeMock).toHaveBeenCalledWith(
      "list_hermes_task_project_assignments",
      scope,
    );
  });

  it("updates local state after create, rename, assignment, and delete mutations", async () => {
    const renamed = {
      ...project,
      name: "Release planning",
      color: "emerald" as const,
      updatedAt: "2026-08-25T12:01:00Z",
    };
    invokeMock.mockImplementation(async (command) => {
      if (command === "list_hermes_task_projects") return [];
      if (command === "list_hermes_task_project_assignments") return [];
      if (command === "create_hermes_task_project") return project;
      if (command === "update_hermes_task_project") return renamed;
      if (
        command === "assign_hermes_task_to_project" ||
        command === "delete_hermes_task_project"
      ) {
        return undefined;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const { result } = renderHook(() => useHermesTaskProjects(scope));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.createProject("Website refresh", "violet");
    });
    expect(result.current.projects).toEqual([project]);

    await act(async () => {
      await result.current.updateProject(
        "project-a",
        "Release planning",
        "emerald",
      );
    });
    expect(result.current.projects).toEqual([renamed]);

    await act(async () => {
      await result.current.assignTask("thread-a", "project-a");
    });
    expect(result.current.assignments).toEqual({ "thread-a": "project-a" });

    await act(async () => {
      await result.current.deleteProject("project-a");
    });
    expect(result.current.projects).toEqual([]);
    expect(result.current.assignments).toEqual({});

    expect(invokeMock).toHaveBeenCalledWith("create_hermes_task_project", {
      ...scope,
      name: "Website refresh",
      color: "violet",
    });
    expect(invokeMock).toHaveBeenCalledWith("assign_hermes_task_to_project", {
      ...scope,
      threadId: "thread-a",
      projectId: "project-a",
    });
  });

  it("ignores stale responses after the local scope changes", async () => {
    let resolveOldProjects: ((value: unknown) => void) | undefined;
    let resolveOldAssignments: ((value: unknown) => void) | undefined;
    const oldProjects = new Promise((resolve) => {
      resolveOldProjects = resolve;
    });
    const oldAssignments = new Promise((resolve) => {
      resolveOldAssignments = resolve;
    });

    invokeMock.mockImplementation(async (command, args) => {
      const conversationId = (args as { conversationId: string })
        .conversationId;
      if (conversationId === "conversation-a") {
        return command === "list_hermes_task_projects"
          ? oldProjects
          : oldAssignments;
      }
      if (command === "list_hermes_task_projects") {
        return [{ ...project, id: "project-b", name: "Current project" }];
      }
      return [{ threadId: "thread-b", projectId: "project-b" }];
    });

    const { result, rerender } = renderHook(
      ({ conversationId }) =>
        useHermesTaskProjects({ userId: "user-a", conversationId }),
      { initialProps: { conversationId: "conversation-a" } },
    );
    rerender({ conversationId: "conversation-b" });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.projects[0]?.id).toBe("project-b");

    await act(async () => {
      resolveOldProjects?.([project]);
      resolveOldAssignments?.([
        { threadId: "thread-a", projectId: "project-a" },
      ]);
      await Promise.resolve();
    });

    expect(result.current.projects[0]?.id).toBe("project-b");
    expect(result.current.assignments).toEqual({ "thread-b": "project-b" });
  });

  it("clears projects from the previous account as soon as the scope changes", async () => {
    let rejectNewScope: ((error: Error) => void) | undefined;
    const newScopeLoad = new Promise((_, reject) => {
      rejectNewScope = reject;
    });
    invokeMock.mockImplementation(async (command, args) => {
      const conversationId = (args as { conversationId: string })
        .conversationId;
      if (conversationId === "conversation-b") return newScopeLoad;
      if (command === "list_hermes_task_projects") return [project];
      return [];
    });

    const { result, rerender } = renderHook(
      ({ userId, conversationId }) =>
        useHermesTaskProjects({ userId, conversationId }),
      {
        initialProps: {
          userId: "user-a",
          conversationId: "conversation-a",
        },
      },
    );

    await waitFor(() => expect(result.current.projects).toEqual([project]));
    rerender({ userId: "user-b", conversationId: "conversation-b" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.projects).toEqual([]);
    expect(result.current.assignments).toEqual({});

    rejectNewScope?.(new Error("local database unavailable"));
    await waitFor(() =>
      expect(result.current.error).toBe("local database unavailable"),
    );
  });
});
