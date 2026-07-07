[CmdletBinding()]
param(
  [int]$MaxIterations = 5,
  [string]$TaskPath = ".codex-loop/remove-agent-chats-ui.md",
  [string]$RunName = "remove-agent-chats-ui",
  [switch]$NoBypass
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-RepoRoot {
  $root = (& git rev-parse --show-toplevel 2>$null)
  if ($LASTEXITCODE -eq 0 -and $root) {
    return ($root | Select-Object -First 1).Trim()
  }

  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function ConvertTo-SafePathPart {
  param([string]$Value)

  $safe = $Value -replace "[^A-Za-z0-9._-]+", "-"
  $safe = $safe.Trim("-")
  if ([string]::IsNullOrWhiteSpace($safe)) {
    return "run"
  }

  return $safe
}

function Get-StatusOutsideLoopRuns {
  $lines = @(& git status --porcelain=v1)
  if ($LASTEXITCODE -ne 0) {
    throw "git status failed"
  }

  return @(
    $lines |
      Where-Object { $_ -and ($_ -notmatch "^\?\? \.codex-loop/runs/" -and $_ -notmatch "^.. \.codex-loop/runs/") } |
      Sort-Object
  )
}

function Convert-StatusToText {
  param([string[]]$StatusLines)

  return ($StatusLines -join "`n")
}

function Invoke-CodexAgent {
  param(
    [string]$Prompt,
    [string]$OutputPath,
    [string]$LogPath,
    [string]$SchemaPath = ""
  )

  $outputParent = Split-Path -Parent $OutputPath
  $logParent = Split-Path -Parent $LogPath
  New-Item -ItemType Directory -Force -Path $outputParent | Out-Null
  New-Item -ItemType Directory -Force -Path $logParent | Out-Null

  $args = @("exec", "--cd", $RepoRoot, "--color", "never")
  if ($NoBypass) {
    $args += @("--sandbox", "danger-full-access")
  } else {
    $args += @("--dangerously-bypass-approvals-and-sandbox")
  }

  if (-not [string]::IsNullOrWhiteSpace($SchemaPath)) {
    $args += @("--output-schema", $SchemaPath)
  }

  $args += @("--output-last-message", $OutputPath, "-")

  $Prompt | & codex @args 2>&1 | Tee-Object -FilePath $LogPath
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "codex exec failed with exit code $exitCode. See $LogPath"
  }
}

$RepoRoot = Get-RepoRoot
Set-Location $RepoRoot

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
  throw "The codex CLI was not found on PATH."
}

$resolvedTaskPath = (Resolve-Path $TaskPath).Path
$schemaPath = (Resolve-Path ".codex-loop/verification.schema.json").Path
$task = Get-Content -LiteralPath $resolvedTaskPath -Raw

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $RepoRoot (Join-Path ".codex-loop/runs" "$timestamp-$(ConvertTo-SafePathPart $RunName)")
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

$permissionMode = if ($NoBypass) {
  "--sandbox danger-full-access"
} else {
  "--dangerously-bypass-approvals-and-sandbox"
}

Write-Host "Codex UI loop"
Write-Host "Repo: $RepoRoot"
Write-Host "Task: $resolvedTaskPath"
Write-Host "Run directory: $runDir"
Write-Host "Permission mode: $permissionMode"
Write-Host "Max iterations: $MaxIterations"

$lastVerifierReport = "No verifier report yet. This is the first implementation pass."

for ($iteration = 1; $iteration -le $MaxIterations; $iteration++) {
  Write-Host ""
  Write-Host "=== Iteration ${iteration}: implementation ==="

  $implOutput = Join-Path $runDir "implementation-$iteration.md"
  $implLog = Join-Path $runDir "implementation-$iteration.log"
  $implementationPrompt = @"
You are the implementation agent for this repository.

Make the requested code changes. Keep the work scoped to the task. You may run
terminal commands, tests, builds, and local app checks as needed.

Important constraints:
- Remove Agent Chats only from user-facing UI access.
- Do not delete backend/service/file-reading/tooling functionality merely to
  hide the UI.
- Preserve unrelated behavior.
- Prefer existing project patterns.
- Before stopping, run the most relevant checks you can reasonably run.

Task spec:
$task

Previous verifier report:
$lastVerifierReport

Loop run directory for notes or artifacts:
$runDir
"@

  Invoke-CodexAgent -Prompt $implementationPrompt -OutputPath $implOutput -LogPath $implLog

  Write-Host ""
  Write-Host "=== Iteration ${iteration}: verification ==="

  $statusBeforeVerify = Convert-StatusToText (Get-StatusOutsideLoopRuns)
  $verifyOutput = Join-Path $runDir "verification-$iteration.json"
  $verifyLog = Join-Path $runDir "verification-$iteration.log"
  $verificationPrompt = @"
You are the independent verification agent for this repository.

Do not edit source code or project configuration. You may run commands, start
local servers, inspect files, use browser or visual tooling, and write reports,
logs, screenshots, or notes only under this loop run directory:
$runDir

Verify the task independently. Be skeptical and concrete.

Required checks:
- Run relevant automated checks for touched desktop UI and affected packages.
- Search for Agent Chat UI exposure in routes, navigation, command palette
  actions, menus, shortcuts, onboarding, and empty states.
- Start and visually inspect the app when practical.
- Verify Workspace is the main/default view once the app is usable.
- Verify first-run onboarding requires registration before app use where
  practical.
- Verify backend Agent Chat implementation was not removed merely to hide UI
  access.

Return only JSON matching the provided schema. Use status "pass" only if the
implementation satisfies the acceptance criteria. If evidence is incomplete,
use status "fail" and describe the missing verification or residual risk as a
blocking issue.

Task spec:
$task
"@

  Invoke-CodexAgent -Prompt $verificationPrompt -OutputPath $verifyOutput -LogPath $verifyLog -SchemaPath $schemaPath

  $statusAfterVerify = Convert-StatusToText (Get-StatusOutsideLoopRuns)
  if ($statusAfterVerify -ne $statusBeforeVerify) {
    $mutationOutput = Join-Path $runDir "verification-$iteration.mutation.json"
    $mutationReport = [ordered]@{
      status = "fail"
      summary = "Verifier changed files outside .codex-loop/runs during verification."
      blocking_issues = @(
        [ordered]@{
          severity = "high"
          file = ""
          issue = "The verifier pass changed repository files outside the loop run artifact directory."
          evidence = "Git status before verification differed from git status after verification."
          recommended_fix = "Inspect the verifier-created changes, keep only intentional implementation changes, and rerun verification."
        }
      )
      checks_run = @(
        [ordered]@{
          name = "Verifier mutation guard"
          command = "git status --porcelain=v1"
          result = "fail"
          notes = "The verification phase must not modify source files or project configuration."
        }
      )
      visual_verification = @()
      residual_risks = @("Verification mutated the repository, so its result is not trusted for this iteration.")
    } | ConvertTo-Json -Depth 8

    Set-Content -LiteralPath $mutationOutput -Value $mutationReport
    $lastVerifierReport = $mutationReport
    Write-Host "Verification failed: verifier changed files outside .codex-loop/runs."
    continue
  }

  $lastVerifierReport = Get-Content -LiteralPath $verifyOutput -Raw
  $report = $lastVerifierReport | ConvertFrom-Json

  if ($report.status -eq "pass") {
    Write-Host ""
    Write-Host "Verification passed on iteration $iteration."
    Write-Host "Final verifier report: $verifyOutput"
    exit 0
  }

  Write-Host "Verification failed on iteration $iteration. Feeding report into next implementation pass."
}

Write-Error "Loop ended without a passing verification report after $MaxIterations iterations. See $runDir"
exit 1
