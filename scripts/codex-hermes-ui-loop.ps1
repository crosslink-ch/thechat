[CmdletBinding()]
param(
  [int]$MaxIterations = 5,
  [switch]$NoBypass
)

$ErrorActionPreference = "Stop"

$loopParams = @{
  MaxIterations = $MaxIterations
  TaskPath = ".codex-loop/hermes-dm-work-in-progress-ui.md"
  RunName = "hermes-dm-work-in-progress-ui"
}

if ($NoBypass) {
  $loopParams.NoBypass = $true
}

& (Join-Path $PSScriptRoot "codex-ui-loop.ps1") @loopParams
