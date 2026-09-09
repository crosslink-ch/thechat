import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReleaseNotesHost } from "../../src/components/ReleaseNotes";
import { SettingsRoute } from "../../src/routes/settings";
import { previewReleaseNotes } from "../../src/stores/release-notes";
import { releaseNotesCatalog } from "../../src/lib/release-notes";
import { useAuthStore } from "../../src/stores/auth";
import { CommandPalette, openPaletteInCommandMode } from "../../src/CommandPalette";
import { createCommands, useCommandsStore } from "../../src/commands";
import { useInputFocusStore } from "../../src/stores/input-focus";
import "../../src/App.css";

// Real Settings, release host and palette; synthetic identity/history only.
// API access's read is intercepted by the browser test. No backend or native calls.
const catalog = [...releaseNotesCatalog, {
  version: "0.8.0", title: "Fixture changes", date: "2026-09-06",
  body: `## Fixture changes\n[Documentation](https://example.com/notes) and [unsafe](javascript:alert(1))\n\n<script>window.releaseNotesUnsafe = true</script>\n\n${"LongUnbrokenFixture".repeat(30)}\n\n${Array.from({ length: 40 }, (_, i) => `- Fixture change ${i}: scrollable release details.`).join("\n")}\n\n\`\`\`text\n${"code".repeat(100)}\n\`\`\``,
}];
useAuthStore.setState({ user: { id: "release-notes-fixture-alice", name: "Fixture User", email: "fixture@example.invalid", avatar: null, type: "human" }, token: null, loading: false });
useCommandsStore.getState().setCommands(createCommands(() => {}));

function Fixture() {
  const [version, setVersion] = useState("0.8.0");
  const [userId, setUserId] = useState("release-notes-fixture-alice");
  const input = useRef<HTMLTextAreaElement>(null);
  const focusTick = useInputFocusStore((state) => state.focusTick);
  useEffect(() => { if (focusTick) input.current?.focus(); }, [focusTick]);
  return <div className="flex h-screen min-h-0 flex-col bg-base text-text">
    <nav aria-label="Fixture controls" className="flex shrink-0 flex-wrap gap-2 p-3">
      <button onClick={openPaletteInCommandMode}>Commands</button>
      <button onClick={() => previewReleaseNotes({ version: "0.9.0", body: "## Upcoming preview\nNot installed yet. [Notes](https://example.com/notes)" })}>Preview available update</button>
      <button onClick={() => setVersion("0.9.0")}>Simulate updated bundle</button>
      <button onClick={() => setUserId("release-notes-fixture-bob")}>Switch account</button>
      <textarea ref={input} aria-label="Fixture composer" />
    </nav>
    <div className="min-h-0 flex-1"><SettingsRoute /></div>
    <CommandPalette />
    <ReleaseNotesHost userId={userId} version={version} catalog={catalog} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
