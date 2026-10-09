$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskUrl = 'http://127.0.0.1:4317'
function Get-TaskLocalHealth {
  $taskRequest = [System.Net.HttpWebRequest]::Create($taskUrl + '/health')
  $taskRequest.Proxy = $null
  $taskRequest.Timeout = 2000
  $taskResponse = $taskRequest.GetResponse()
  try { $taskReader = New-Object System.IO.StreamReader($taskResponse.GetResponseStream()); return ($taskReader.ReadToEnd() | ConvertFrom-Json) }
  finally { $taskResponse.Close() }
}
try {
  $taskHealth = Get-TaskLocalHealth
  if ($taskHealth.app -eq 'agent-room') { Start-Process $taskUrl; exit }
} catch {}
$taskNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$taskNode = if ($taskNodeCommand) { $taskNodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $taskNode)) { throw 'Node.js was not found. Install Node.js 22 or later, then run this launcher again.' }
$taskData = Join-Path $taskRoot 'data'
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList ('"' + (Join-Path $taskRoot 'server.mjs') + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskData 'server.log') -RedirectStandardError (Join-Path $taskData 'server-error.log') -PassThru
Set-Content -LiteralPath (Join-Path $taskData 'server.pid') -Value $taskProcess.Id
for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
  Start-Sleep -Milliseconds 400
  try { $taskHealth = Get-TaskLocalHealth; if ($taskHealth.app -eq 'agent-room') { Start-Process $taskUrl; exit } } catch {}
}
throw 'The room could not start. See data\server-error.log.'
