import { beforeEach, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReleaseNotesHost } from "./ReleaseNotes";
import { createReleaseNotesSeenState } from "../lib/release-notes-state";
import { openReleaseNotes, previewReleaseNotes, useReleaseNotesStore } from "../stores/release-notes";

const catalog = [
  { version: "2.0.0", title: "Next release", date: "2026-09-09", body: "Future changes." },
  { version: "1.0.0", title: "Current release", date: "2026-09-08", body: "Current changes." },
];
beforeEach(() => {
  localStorage.clear();
  useReleaseNotesStore.setState({ request: null });
});

it("opts out of future release prompts across reloads while keeping manual access and re-enabling available", async () => {
  const first = render(<ReleaseNotesHost userId="alice" version="1.0.0" catalog={catalog} seen={createReleaseNotesSeenState(() => localStorage)} />);
  const preference = screen.getByRole("checkbox", { name: "Don't show release notes automatically" });
  expect(preference).not.toBeChecked();
  await userEvent.click(preference);
  // Let the user finish reading rather than disappearing underneath the checkbox.
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  first.unmount();

  const second = render(<ReleaseNotesHost userId="alice" version="2.0.0" catalog={catalog} seen={createReleaseNotesSeenState(() => localStorage)} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => openReleaseNotes());
  expect(screen.getByText("Future changes.")).toBeInTheDocument();
  const savedPreference = screen.getByRole("checkbox", { name: "Don't show release notes automatically" });
  expect(savedPreference).toBeChecked();
  await userEvent.click(savedPreference);
  await userEvent.keyboard("{Escape}");
  second.unmount();

  render(<ReleaseNotesHost userId="alice" version="2.0.0" catalog={catalog} seen={createReleaseNotesSeenState(() => localStorage)} />);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("does not show a pending automatic notice after opting out from an update preview", async () => {
  act(() => previewReleaseNotes({ version: "2.0.0", body: "Upcoming changes." }));
  const seen = createReleaseNotesSeenState(() => localStorage);
  render(<ReleaseNotesHost userId="alice" version="1.0.0" catalog={catalog} seen={seen} />);
  await userEvent.click(screen.getByRole("checkbox", { name: "Don't show release notes automatically" }));
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(seen.hasSeen("alice", "1.0.0")).toBe(false);
  expect(seen.hasSeen("alice", "2.0.0")).toBe(false);
});

it("keeps preferences isolated when the account changes during manual history", async () => {
  const seen = createReleaseNotesSeenState(() => localStorage);
  seen.setAutomaticDisabled("alice", true);
  act(() => openReleaseNotes());
  const app = render(<ReleaseNotesHost userId="alice" version="1.0.0" catalog={catalog} seen={seen} />);
  expect(screen.getByRole("checkbox")).toBeChecked();
  app.rerender(<ReleaseNotesHost userId="bob" version="1.0.0" catalog={catalog} seen={seen} />);
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  await userEvent.click(screen.getByRole("checkbox"));
  expect(createReleaseNotesSeenState(() => localStorage).isAutomaticDisabled("alice")).toBe(true);
  expect(createReleaseNotesSeenState(() => localStorage).isAutomaticDisabled("bob")).toBe(true);
  app.rerender(<ReleaseNotesHost userId="alice" version="1.0.0" catalog={catalog} seen={seen} />);
  expect(screen.getByRole("checkbox")).toBeChecked();
});

it.each(["blocked", "quota"])("retains opt-out for this session if storage is %s", async (failure) => {
  const seen = createReleaseNotesSeenState(() => {
    if (failure === "blocked") throw new Error("Storage blocked");
    return { getItem: () => null, setItem: () => { throw new Error("Quota exceeded"); } };
  });
  const app = render(<ReleaseNotesHost userId="alice" version="1.0.0" catalog={catalog} seen={seen} />);
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.keyboard("{Escape}");
  app.rerender(<ReleaseNotesHost userId="alice" version="2.0.0" catalog={catalog} seen={seen} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => openReleaseNotes());
  expect(screen.getByRole("checkbox")).toBeChecked();
  expect(seen.isAutomaticDisabled("bob")).toBe(false);
});

it("does not offer an account preference before sign-in", () => {
  act(() => previewReleaseNotes({ version: "2.0.0", body: "Upcoming changes." }));
  render(<ReleaseNotesHost userId={null} version="1.0.0" catalog={catalog} />);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});
