import { cleanup, render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { WorkspaceModal, openWorkspaceModal } from "./WorkspaceModal";

afterEach(cleanup);
it("names the workspace dialog and offers a keyboard/touch close control", async () => {
  const user = userEvent.setup();
  render(<WorkspaceModal/>);
  act(() => openWorkspaceModal());
  expect(screen.getByRole("dialog", {name:"Create workspace"})).toBeInTheDocument();
  expect(screen.getByRole("textbox", {name:"Workspace name"})).toHaveFocus();
  await user.type(screen.getByRole("textbox", {name:"Workspace name"}), "Phone workspace");
  await user.click(screen.getByRole("button", {name:"Close workspace dialog"}));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});
