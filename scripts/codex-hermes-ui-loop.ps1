[CmdletBinding()]
param(
  [int]$MaxIterations = 5,
  [switch]$NoBypass
)

$ErrorActionPreference = "Stop"

$argsForLoop = @(
  "-MaxIterations", $MaxIterations,
  "-TaskPath", ".codex-loop/hermes-dm-work-in-progress-ui.md",
  "-RunName", "hermes-dm-work-in-progress-ui"
)

if ($NoBypass) {
  $argsForLoop += "-NoBypass"
}

& (Join-Path $PSScriptRoot "codex-ui-loop.ps1") @argsForLoop

