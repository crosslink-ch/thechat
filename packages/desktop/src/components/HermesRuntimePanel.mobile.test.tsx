import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { HermesRuntimePanel } from "./HermesRuntimePanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("lets a phone user open tasks, select General and return to the chat", async () => {
  vi.stubGlobal("matchMedia", () => ({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<HermesRuntimePanel botName="Hermes" runtime={null} loading={false} onSelectThread={onSelect} onCreateThread={vi.fn()} />);
  const trigger = screen.getByRole("button", {name:"Open tasks and activity"});
  await user.click(trigger);
  expect(screen.getByRole("dialog", {name:"Tasks and activity"})).toBeInTheDocument();
  await user.click(screen.getByRole("button", {name:/General/}));
  expect(onSelect).toHaveBeenCalledWith(null);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});
