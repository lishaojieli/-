$ErrorActionPreference = 'Stop'
$taskPidFile = Join-Path $PSScriptRoot 'data\server.pid'
if (Test-Path -LiteralPath $taskPidFile) {
  $taskProcessId = [int](Get-Content -LiteralPath $taskPidFile)
  $taskProcess = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $taskProcessId)
  $taskExpectedScript = Join-Path $PSScriptRoot 'server.mjs'
  if ($taskProcess -and $taskProcess.CommandLine.Contains($taskExpectedScript)) {
    $taskChildren = Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $taskProcessId) | Where-Object { $_.Name -eq 'codex.exe' -and $_.CommandLine -match 'app-server' }
    Stop-Process -Id $taskProcessId
    foreach ($taskChild in $taskChildren) {
      $taskCurrentChild = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $taskChild.ProcessId)
      if ($taskCurrentChild -and $taskCurrentChild.CreationDate -eq $taskChild.CreationDate) { Stop-Process -Id $taskChild.ProcessId -ErrorAction SilentlyContinue }
    }
  }
}
