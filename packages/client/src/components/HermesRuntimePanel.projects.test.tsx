import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationThreadPublic, TaskProjectPublic } from "@thechat/shared";
import { CommandPalette, closePalette, openPaletteInCommandMode } from "../CommandPalette";
import { useCommandsStore } from "../commands";
import { HermesRuntimePanel } from "./HermesRuntimePanel";

const at = "2026-10-20T12:00:00.000Z";
const project = (id: string, name: string): TaskProjectPublic => ({
  id, conversationId: "dm-1", name, createdById: "user-1", createdAt: at, updatedAt: at,
});
const task = (id: string, title: string, projectId: string | null): ConversationThreadPublic => ({
  id, conversationId: "dm-1", botId: "bot-1", title, status: "active", projectId,
  createdById: "user-1", lastActivityAt: at, createdAt: at, updatedAt: at,
});

const research = project("project-research", "Research");
const launch = project("project-launch", "Launch");
const pricing = task("task-pricing", "Competitor pricing", research.id);
const inbox = task("task-inbox", "Inbox zero", null);

function handlers() {
  return {
    onCreateProject: vi.fn(async (name: string) => project("project-new", name)),
    onRenameProject: vi.fn().mockResolvedValue(undefined),
    onDeleteProject: vi.fn().mockResolvedValue(undefined),
    onMoveThread: vi.fn().mockResolvedValue(undefined),
    onDeleteThread: vi.fn().mockResolvedValue(undefined),
    onCreateThread: vi.fn(),
  };
}

function renderPanel(
  h = handlers(),
  {
    projects = [research, launch],
    threads = [pricing, inbox],
    activeThreadId = inbox.id as string | null,
  } = {},
) {
  render(
    <>
      <HermesRuntimePanel
        botName="Hermes"
        runtime={{ invocations: [], events: [] }}
        loading={false}
        threads={threads}
        projects={projects}
        activeThreadId={activeThreadId}
        {...h}
      />
      <CommandPalette />
    </>,
  );
  return h;
}

async function runCommand(user: ReturnType<typeof userEvent.setup>, label: string) {
  await act(async () => openPaletteInCommandMode());
  await user.type(screen.getByPlaceholderText("Type a command..."), label);
  await user.click(screen.getByRole("button", { name: label }));
}

beforeEach(() => {
  closePalette();
  useCommandsStore.setState({ globalCommands: [], scopedCommands: {}, commands: [] });
});
afterEach(() => {
  cleanup();
  closePalette();
  vi.restoreAllMocks();
});

describe("Hermes task projects", () => {
  it("groups tasks by project with tasks without one listed last", () => {
    renderPanel();
    const researchGroup = screen.getByRole("group", { name: "Project Research" });
    expect(within(researchGroup).getByText("Competitor pricing")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Project Launch" })).getByText("Drag tasks here"))
      .toBeInTheDocument();
    const unfiled = screen.getByRole("group", { name: "Tasks without a project" });
    expect(within(unfiled).getByText("Inbox zero")).toBeInTheDocument();
    const groups = screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"));
    expect(groups).toEqual(["Project Research", "Project Launch", "Tasks without a project"]);
  });

  it("creates a project from the New Project command palette entry", async () => {
    const user = userEvent.setup();
    const h = renderPanel();
    await runCommand(user, "New Project");

    expect(screen.queryByTestId("palette-panel")).not.toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Project name" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.type(input, "  Q4   planning ");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(h.onCreateProject).toHaveBeenCalledWith("Q4 planning"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows the server's error and keeps the dialog open when creation fails", async () => {
    const user = userEvent.setup();
    const h = handlers();
    h.onCreateProject.mockRejectedValueOnce(new Error("A project with this name already exists"));
    renderPanel(h);
    await user.click(screen.getByRole("button", { name: "New project" }));
    await user.type(screen.getByRole("textbox", { name: "Project name" }), "Research");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A project with this name already exists",
    );
    expect(screen.getByRole("dialog", { name: "New project" })).toBeInTheDocument();
  });

  it("moves the active task with the Move Task to Project command", async () => {
    const user = userEvent.setup();
    const h = renderPanel();
    await runCommand(user, "Move Task to Project");

    const dialog = screen.getByRole("dialog", { name: "Move “Inbox zero”" });
    expect(within(dialog).getByRole("button", { name: /No project/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await user.click(within(dialog).getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(h.onMoveThread).toHaveBeenCalledWith(inbox.id, launch.id));
  });

  it("moves a task from its row menu, including out of its project", async () => {
    const user = userEvent.setup();
    const h = renderPanel();
    await user.click(screen.getByRole("button", { name: "Task actions for Competitor pricing" }));
    await user.click(await screen.findByRole("menuitem", { name: "Move to project..." }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "No project" }),
    );
    await waitFor(() => expect(h.onMoveThread).toHaveBeenCalledWith(pricing.id, null));
  });

  it("creates a project and files the task in one step when there are no projects", async () => {
    const user = userEvent.setup();
    const h = renderPanel(handlers(), { projects: [] });
    await user.click(screen.getByRole("button", { name: "Task actions for Inbox zero" }));
    await user.click(await screen.findByRole("menuitem", { name: "New project from task..." }));
    await user.type(screen.getByRole("textbox", { name: "Project name" }), "Chores");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(h.onMoveThread).toHaveBeenCalledWith(inbox.id, "project-new"));
  });

  it("drags a task onto a project", async () => {
    const h = renderPanel();
    const row = screen.getByText("Inbox zero").closest("[data-task-row]")!;
    const target = screen.getByRole("group", { name: "Project Launch" });
    // jsdom does no layout, so hit-testing is stubbed; a real browser covers it in e2e.
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => target,
    });
    try {
      fireEvent.pointerDown(row, { button: 0, pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 30, clientY: 60 });
      expect(target.className).toContain("border-accent");
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 30, clientY: 60 });
    } finally {
      delete (document as { elementFromPoint?: unknown }).elementFromPoint;
    }

    expect(h.onMoveThread).toHaveBeenCalledWith(inbox.id, launch.id);
  });

  it("treats a short press as a click and not a drag", () => {
    const h = handlers();
    const onSelectThread = vi.fn();
    render(
      <HermesRuntimePanel botName="Hermes" runtime={null} loading={false}
        threads={[pricing, inbox]} projects={[research]} onSelectThread={onSelectThread} {...h} />,
    );
    const row = screen.getByText("Inbox zero").closest("[data-task-row]")!;
    fireEvent.pointerDown(row, { button: 0, pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 12, clientY: 11 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 12, clientY: 11 });
    fireEvent.click(screen.getByText("Inbox zero"));

    expect(h.onMoveThread).not.toHaveBeenCalled();
    expect(onSelectThread).toHaveBeenCalledWith(inbox.id);
  });

  it("deletes the active task from the palette only after confirmation", async () => {
    const user = userEvent.setup();
    const h = renderPanel();
    await runCommand(user, "Delete Task");

    const dialog = screen.getByRole("dialog", { name: "Delete task “Inbox zero”?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus());
    expect(h.onDeleteThread).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Delete task" }));
    await waitFor(() => expect(h.onDeleteThread).toHaveBeenCalledWith(inbox.id));
  });

  it("keeps the confirmation open with the reason when deletion is refused", async () => {
    const user = userEvent.setup();
    const h = handlers();
    h.onDeleteThread.mockRejectedValueOnce(
      new Error("Wait for the bot to finish working on this task before deleting it"),
    );
    renderPanel(h);
    await user.click(screen.getByRole("button", { name: "Task actions for Inbox zero" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete task..." }));
    await user.click(screen.getByRole("button", { name: "Delete task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wait for the bot to finish");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("renames and deletes a project from its menu", async () => {
    const user = userEvent.setup();
    const h = renderPanel();
    await user.click(screen.getByRole("button", { name: "Project actions for Research" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename project..." }));
    const input = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(input);
    await user.type(input, "Market research");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(h.onRenameProject).toHaveBeenCalledWith(research.id, "Market research"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Project actions for Research" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete project..." }));
    expect(screen.getByRole("dialog")).toHaveTextContent("No tasks are deleted.");
    await user.click(screen.getByRole("button", { name: "Delete project" }));
    await waitFor(() => expect(h.onDeleteProject).toHaveBeenCalledWith(research.id));
  });

  it("starts a new task inside a project", async () => {
    const user = userEvent.setup();
    const h = renderPanel();
    await user.click(screen.getByRole("button", { name: "New task in Launch" }));
    expect(h.onCreateThread).toHaveBeenCalledWith(launch.id);
  });

  it("offers task commands only for a saved active task", () => {
    renderPanel(handlers(), { activeThreadId: null });
    const ids = useCommandsStore.getState().commands.map((command) => command.id);
    expect(ids).toContain("hermes.new-project");
    expect(ids).not.toContain("hermes.move-task");
    expect(ids).not.toContain("hermes.delete-task");
  });
});
