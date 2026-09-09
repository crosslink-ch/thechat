import { beforeEach, describe, expect, it } from "vitest";
import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReleaseNotesHost } from "./ReleaseNotes";
import { createReleaseNotesSeenState } from "../lib/release-notes-state";
import { openReleaseNotes, previewReleaseNotes, useReleaseNotesStore } from "../stores/release-notes";

const catalog = [
  { version: "0.9.0", title: "Activity inbox", date: "2026-09-07", body: "## What's new\nPersistent unread state." },
  { version: "0.8.0", title: "Earlier release", date: "2026-09-06", body: "Previous changes." },
];
let seen: ReturnType<typeof createReleaseNotesSeenState>;
beforeEach(() => {
  localStorage.clear();
  useReleaseNotesStore.setState({ request: null });
  seen = createReleaseNotesSeenState(() => localStorage);
});

describe("installed release notes", () => {
  it("keeps the prompt dismissed in-session when the browser blocks storage", async () => {
    seen = createReleaseNotesSeenState(() => { throw new Error("Storage blocked"); });
    const view = <ReleaseNotesHost userId="alice" version="0.9.0" catalog={catalog} seen={seen} />;
    const app = render(view);
    await userEvent.keyboard("{Escape}");
    app.unmount();
    render(view);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["0.0.0-dev", "0.9.0-beta.1"])("never auto-prompts for %s even if notes are bundled", (version) => {
    render(<ReleaseNotesHost userId="alice" version={version} catalog={[{ ...catalog[0], version }]} seen={seen} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("manually opens a completely empty catalog", () => {
    render(<ReleaseNotesHost userId="alice" version="0.9.0" catalog={[]} seen={seen} />);
    act(() => openReleaseNotes());
    expect(screen.getByText("Release notes are not available for this version.")).toBeInTheDocument();
  });
  it("manually reopens dismissed notes and browses bundled history without changing dismissal", async () => {
    seen.dismiss("alice", "0.9.0");
    render(<ReleaseNotesHost userId="alice" version="0.9.0" catalog={catalog} seen={seen} />);
    act(() => openReleaseNotes());
    expect(screen.getByText("Persistent unread state.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Release history" }), "0.8.0");
    expect(screen.getByText("Previous changes.")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(seen.hasSeen("alice", "0.8.0")).toBe(false);
    act(() => openReleaseNotes());
    expect(screen.getByText("Persistent unread state.")).toBeInTheDocument();
  });

  it("manual development and missing catalog views give an honest empty state", async () => {
    render(<ReleaseNotesHost userId="alice" version="0.0.0-dev" catalog={catalog} seen={seen} />);
    act(() => openReleaseNotes());
    expect(screen.getByText("Release notes are not available for this version.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Release history" }), "0.9.0");
    expect(screen.getByText("Persistent unread state.")).toBeInTheDocument();
  });

  it("previews an upcoming update without acknowledging it or the installed version", async () => {
    act(() => previewReleaseNotes({ version: "0.9.0", body: "## Preview\nUpcoming changes." }));
    const app = render(<ReleaseNotesHost userId="alice" version="0.8.0" catalog={catalog} seen={seen} />);
    expect(screen.getByRole("dialog", { name: "Update release notes" })).toBeInTheDocument();
    expect(screen.getByText("Upcoming changes.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(seen.hasSeen("alice", "0.8.0")).toBe(false);
    expect(seen.hasSeen("alice", "0.9.0")).toBe(false);
    expect(screen.getByText("Previous changes.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    app.rerender(<ReleaseNotesHost userId="alice" version="0.9.0" catalog={catalog} seen={seen} />);
    expect(screen.getByText("Persistent unread state.")).toBeInTheDocument();
  });

  it("shows an empty preview if the updater provides no notes", () => {
    act(() => previewReleaseNotes({ version: "0.9.0" }));
    render(<ReleaseNotesHost userId={null} version="0.8.0" catalog={catalog} seen={seen} />);
    expect(screen.getByText("Release notes are not available for this version.")).toBeInTheDocument();
  });
  it.each(["0.0.0-dev", "0.9.0-beta.1", "unknown", "0.7.0"])("does not auto-prompt for development, prerelease or missing version %s", (version) => {
    render(<ReleaseNotesHost userId="alice" version={version} catalog={catalog} seen={seen} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("prompts for the next installed version and separates accounts", async () => {
    const app = render(<ReleaseNotesHost userId="alice" version="0.8.0" catalog={catalog} seen={seen} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    app.rerender(<ReleaseNotesHost userId="alice" version="0.9.0" catalog={catalog} seen={seen} />);
    expect(screen.getByText("Persistent unread state.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    app.rerender(<ReleaseNotesHost userId="bob" version="0.9.0" catalog={catalog} seen={seen} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    app.rerender(<ReleaseNotesHost userId={null} version="0.9.0" catalog={catalog} seen={seen} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders bundled Markdown without executing HTML or unsafe URLs", () => {
    const unsafe = [{ ...catalog[0], body: '## Read this\n**Bold** and [Docs](https://example.com/notes). [Bad](javascript:alert(1))\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1) />' }];
    render(<ReleaseNotesHost userId="alice" version="0.9.0" catalog={unsafe} seen={seen} />);
    expect(screen.getByRole("heading", { name: "Read this" })).toBeInTheDocument();
    expect(screen.getByText("Bold").tagName).toBe("STRONG");
    const link = screen.getByRole("link", { name: "Docs" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(document.querySelector('script, img[onerror], a[href^="javascript:"]')).toBeNull();
  });

  it("opens only after identity is ready, survives StrictMode, and stays dismissed on navigation/remount", async () => {
    const view = (userId: string | null) => <StrictMode><ReleaseNotesHost userId={userId} catalog={catalog} version="0.9.0" seen={seen} /></StrictMode>;
    const app = render(view(null));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    app.rerender(view("alice"));
    expect(await screen.findByRole("dialog", { name: "What's new" })).toBeInTheDocument();
    expect(screen.getByText("Persistent unread state.")).toBeInTheDocument();
    expect(seen.hasSeen("alice", "0.9.0")).toBe(false);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(seen.hasSeen("alice", "0.9.0")).toBe(true);
    app.rerender(view("alice"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    app.unmount();
    seen = createReleaseNotesSeenState(() => localStorage);
    render(view("alice"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
