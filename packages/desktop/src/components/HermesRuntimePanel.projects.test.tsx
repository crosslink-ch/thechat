import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import type { ConversationThreadPublic } from "@thechat/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HermesRuntimePanel } from "./HermesRuntimePanel";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const project = {
  id: "project-a",
  name: "Website refresh",
  color: "violet",
  position: 0,
  createdAt: "2026-08-25T12:00:00Z",
  updatedAt: "2026-08-25T12:00:00Z",
};

function thread(id: string, title: string): ConversationThreadPublic {
  const timestamp = "2026-08-25T12:00:00Z";
  return {
    id,
    conversationId: "conversation-a",
    botId: "bot-a",
    title,
    status: "active",
    createdById: "user-a",
    lastActivityAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const threads = [
  thread("thread-a", "Polish onboarding flow"),
  thread("thread-b", "Build launch checklist"),
  thread("thread-c", "Investigate search latency"),
];

function renderPanel() {
  return render(
    <HermesRuntimePanel
      botName="Hermes"
      runtime={null}
      loading={false}
      userId="user-a"
      conversationId="conversation-a"
      threads={threads}
      activeThreadId="thread-a"
      onSelectThread={() => {}}
      onCreateThread={() => {}}
    />,
  );
}

function mockLocalState(
  projects: unknown[] = [],
  assignments: unknown[] = [],
  mutations: Partial<Record<string, unknown>> = {},
) {
  invokeMock.mockImplementation(async (command) => {
    if (command === "list_hermes_task_projects") return projects;
    if (command === "list_hermes_task_project_assignments") return assignments;
    if (command in mutations) return mutations[command];
    throw new Error(`unexpected command: ${command}`);
  });
}

describe("Hermes task projects", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("creates a device-local project from the Tasks panel", async () => {
    mockLocalState([], [], { create_hermes_task_project: project });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "New project" }));
    expect(screen.getByText("Saved only on this device")).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Project name" }),
      project.name,
    );
    await user.click(screen.getByRole("button", { name: "Use Violet" }));
    await user.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByText(project.name)).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("create_hermes_task_project", {
      userId: "user-a",
      conversationId: "conversation-a",
      name: project.name,
      color: "violet",
    });
    expect(screen.getByText("Unfiled")).toBeInTheDocument();
  });

  it("moves tasks between local groups from the organize menu", async () => {
    mockLocalState(
      [project],
      [{ threadId: "thread-a", projectId: project.id }],
      { assign_hermes_task_to_project: undefined },
    );
    const user = userEvent.setup();
    renderPanel();

    const projectGroup = await screen.findByTestId("hermes-project-project-a");
    expect(
      within(projectGroup).getByText("Polish onboarding flow"),
    ).toBeInTheDocument();
    const unfiled = screen.getByTestId("hermes-project-unfiled");
    expect(
      within(unfiled).getByText("Build launch checklist"),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Organize Build launch checklist" }),
    );
    await user.click(
      within(screen.getByRole("menu")).getByRole("menuitem", {
        name: "Website refresh",
      }),
    );

    await waitFor(() =>
      expect(
        within(projectGroup).getByText("Build launch checklist"),
      ).toBeInTheDocument(),
    );
    expect(invokeMock).toHaveBeenCalledWith("assign_hermes_task_to_project", {
      userId: "user-a",
      conversationId: "conversation-a",
      threadId: "thread-b",
      projectId: "project-a",
    });
  });

  it("renames and deletes a local project without deleting its tasks", async () => {
    const renamed = { ...project, name: "Release planning", color: "rose" };
    mockLocalState(
      [project],
      [{ threadId: "thread-a", projectId: project.id }],
      {
        update_hermes_task_project: renamed,
        delete_hermes_task_project: undefined,
      },
    );
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole("button", {
        name: "Project actions for Website refresh",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit project" }));
    const nameInput = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(nameInput);
    await user.type(nameInput, renamed.name);
    await user.click(screen.getByRole("button", { name: "Use Rose" }));
    await user.click(screen.getByRole("button", { name: "Save project" }));

    expect(await screen.findByText(renamed.name)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "Project actions for Release planning",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete project" }));
    const confirmation = screen.getByRole("alertdialog");
    expect(
      within(confirmation).getByText(/Tasks will become unfiled/),
    ).toBeInTheDocument();
    await user.click(
      within(confirmation).getByRole("button", { name: "Delete project" }),
    );

    await waitFor(() =>
      expect(screen.queryByText(renamed.name)).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Polish onboarding flow")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("delete_hermes_task_project", {
      userId: "user-a",
      conversationId: "conversation-a",
      projectId: "project-a",
    });
  });

  it("supports dragging a task into a project", async () => {
    mockLocalState([project], [], { assign_hermes_task_to_project: undefined });
    renderPanel();

    const row = await screen.findByTestId("hermes-task-thread-c");
    const target = screen.getByTestId("hermes-project-project-a");
    const dataTransfer = {
      setData: vi.fn(),
      getData: vi.fn(() => "thread-c"),
      effectAllowed: "move",
      dropEffect: "move",
    };
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("assign_hermes_task_to_project", {
        userId: "user-a",
        conversationId: "conversation-a",
        threadId: "thread-c",
        projectId: "project-a",
      }),
    );
  });
});
