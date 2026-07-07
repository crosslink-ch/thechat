# Codex UI Removal Loop

This directory contains the prompt and schema used by `scripts/codex-ui-loop.ps1`.

Run from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-ui-loop.ps1
```

The script runs separate Codex implementation and verification agents until the
verifier returns `status: "pass"` or the iteration limit is reached.

By default, each Codex run uses
`--dangerously-bypass-approvals-and-sandbox` so noninteractive agents can run
commands, start servers, and use verification tooling without waiting for
approval prompts. To keep full filesystem access but avoid the bypass flag, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/codex-ui-loop.ps1 -NoBypass
```

Generated reports, logs, and screenshots are written under `.codex-loop/runs/`
and are ignored by git.
