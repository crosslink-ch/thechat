# Shipping release notes

`release-notes.json` is the versioned source of truth for the notes bundled with
TheChat. The web and desktop clients render these notes inside the app. The
Release workflow also uses the exact version's `body` for the GitHub release and
Tauri's `latest.json` updater notes, so users can read changes before restarting.
The app does not need GitHub credentials or a live GitHub API request to display
its installed release notes.

## Prepare a release

1. Add a new entry at the **beginning** of `release-notes.json` in the same commit
   as the release's code. Retain older entries for in-app history. Each entry has:
   - `version`: the exact stable version without the `v` prefix, such as `1.2.0`;
   - `title`: a short, user-facing summary;
   - `date`: a valid `YYYY-MM-DD` release date;
   - `body`: non-empty Markdown describing changes users can actually use.
2. Run the lightweight validation and tests:
   ```sh
   node scripts/release-notes.mjs --check
   node --test scripts/release-notes.test.mjs
   ```
3. Preview the exact text for the intended release:
   ```sh
   node scripts/release-notes.mjs v1.2.0
   ```
4. Follow the normal release procedure: tag the reviewed commit with that exact
   `vX.Y.Z`. The Release workflow validates the tag and fails if its notes are
   missing or invalid. A manually dispatched Release run must select a version
   tag, not `main`. Prereleases are not supported by this stable-release workflow.
5. Review the draft GitHub release and publish it after the platform assets and
   updater manifest are complete. Do not replace its body with generic download
   instructions; the catalog should remain the authoritative user-facing copy.

A release tag uses its **own exact entry**, even when rebuilding an older tag.
It must never use the newest entry as a fallback. The catalog is checked for
unique versions, numerical newest-first order, valid dates, and non-empty copy.
The initial catalog starts at v0.9.0 using that release's published feature notes;
it does not invent historical or future versions.

## In-app behavior

- After sign-in, a shipped stable version can show its notes once per account on
  that browser/device. Dismissing the dialog acknowledges only that installed
  version. Clearing local app storage can cause the notice to appear again.
- The dialog includes **Don't show release notes automatically**. This opt-out
  persists per account on the current browser/device and suppresses future
  automatic notices, not just the currently displayed release. If storage is
  blocked/full, it is retained for the current session.
- Notes remain accessible from Settings and the command palette after dismissal
  or opting out. Uncheck the preference in the manually opened dialog to allow
  future automatic notices again. Development builds also allow managing this
  preference without automatically displaying release notes.
- The desktop update notification can preview the **available update's** notes
  without installing it or acknowledging that version as already seen. The
  existing explicit restart action is unchanged.
- Development builds do not automatically announce a release. Missing notes have
  an honest empty state; they are not replaced with another version's notes.
- The web app uses the newest release bundled into its build. It shows new notes
  after that build is deployed and the page loads/reloads. Publishing a GitHub
  release does not remotely replace already-loaded browser code.
- This feature does not publish releases, auto-reload browser tabs, or install
  desktop updates without the existing user action.

For web deployments, `deploy/web/Dockerfile` explicitly copies
`release-notes.json` from its allowlisted root workspace context. Catalog changes
also trigger the Web Docker Image workflow. Rebuild/deploy the web image
from the release commit to ship its updated catalog.


## Manual review fixture

Run `pnpm --filter @thechat/desktop dev:web` and open
`http://localhost:1420/browser-tests/fixtures/release-notes-review.html`.
This isolated fixture uses the real dialog and local preference store, but no
account or backend. It deliberately simulates production notices in development.
Use **Show release notes**, **Simulate another release**, **Reload preview**, and
**Reset demo** to check the opt-out and re-enable flow. Simulated entries are
explicitly labelled and do not modify the release catalog or a real account.

Keep Vite bound to loopback. For a remote human review, build this HTML entry
with Vite in web mode and serve only its compiled output through a temporary,
access-controlled preview URL; do not publish the development source server.
