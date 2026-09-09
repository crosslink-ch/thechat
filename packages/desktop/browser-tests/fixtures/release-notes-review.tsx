import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReleaseNotesHost } from "../../src/components/ReleaseNotes";
import { releaseNotesCatalog } from "../../src/lib/release-notes";
import { openReleaseNotes } from "../../src/stores/release-notes";
import "../../src/App.css";

// Manual review only: the real dialog and preference store, no account/API calls.
const userId = "release-notes-review";
const counterKey = "thechat:release-notes-review:counter";
function initialCounter() {
  try {
    const value = Number(localStorage.getItem(counterKey) ?? "0");
    return Number.isSafeInteger(value) && value >= 0 && value < 10000 ? value : 0;
  } catch { return 0; }
}
function Review() {
  const [counter, setCounter] = useState(initialCounter);
  const current = releaseNotesCatalog[0];
  const catalog = useMemo(() => {
    if (!counter) return releaseNotesCatalog;
    const [major, minor, patch] = current.version.split(".").map(Number);
    return [{
      version: `${major}.${minor}.${patch + counter}`,
      title: "Simulated future release",
      date: current.date,
      body: "## This is a demo release\n\nThis entry is only for manual review, not a published TheChat release.\n\n- If you disabled automatic release notes, this dialog should open only when you choose **Show release notes**.\n- Uncheck **Don't show release notes automatically**, close this dialog, then choose **Simulate another release** to turn automatic prompts back on.\n\nYour preference here is isolated from your real TheChat account.",
    }, ...releaseNotesCatalog];
  }, [counter, current]);
  const version = catalog[0].version;
  const simulate = () => {
    const next = counter + 1;
    try { localStorage.setItem(counterKey, String(next)); } catch { /* private browser */ }
    setCounter(next);
  };
  const reset = () => {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key === counterKey || key === `thechat:release-notes:automatic-disabled:${userId}` || key.startsWith(`thechat:release-notes:seen:${userId}:`)) localStorage.removeItem(key);
      }
    } catch { /* reload also clears the session-only fallback */ }
    location.reload();
  };
  const secondary = "cursor-pointer rounded-lg border border-border-strong bg-surface px-4 py-2.5 text-sm font-medium text-text transition-colors hover:bg-elevated";
  return <main className="min-h-dvh bg-base px-5 py-8 text-text sm:px-8 sm:py-12">
    <div className="mx-auto flex max-w-[760px] flex-col gap-7">
      <header>
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-accent">TheChat · Preview</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Release notes review</h1>
        <p className="mt-3 max-w-[620px] text-sm leading-6 text-text-muted">Try the actual release-notes dialog and the new opt-out. This is an isolated preview with demo state, no login and no connection to your real account.</p>
      </header>
      <section className="rounded-xl border border-border-strong bg-surface p-5 sm:p-6" aria-label="Preview controls">
        <p role="status" className="mb-4 text-sm text-text-muted">Reviewing version {version}{counter ? " (simulated)" : " (bundled release notes)"}</p>
        <div className="flex flex-wrap gap-3">
          <button className="cursor-pointer rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:opacity-90" onClick={openReleaseNotes}>Show release notes</button>
          <button className={secondary} onClick={simulate}>Simulate another release</button>
          <button className={secondary} onClick={() => location.reload()}>Reload preview</button>
          <button className={secondary} onClick={reset}>Reset demo</button>
        </div>
      </section>
      <section className="text-sm leading-7 text-text-muted" aria-label="How to review">
        <h2 className="mb-2 font-semibold text-text">What to check</h2>
        <ol className="list-decimal space-y-2 pl-5">
          <li>Read the notes, check <strong className="text-text">Don't show release notes automatically</strong>, then close the dialog.</li>
          <li>Choose <strong className="text-text">Simulate another release</strong>. The automatic dialog should stay hidden, including after a reload.</li>
          <li>Choose <strong className="text-text">Show release notes</strong>. Manual access still works. Uncheck the preference to enable future automatic prompts again.</li>
          <li><strong className="text-text">Reset demo</strong> restores the first-visit experience. Your real app preferences are never changed.</li>
        </ol>
      </section>
    </div>
    <ReleaseNotesHost userId={userId} version={version} catalog={catalog} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Review /></StrictMode>);
