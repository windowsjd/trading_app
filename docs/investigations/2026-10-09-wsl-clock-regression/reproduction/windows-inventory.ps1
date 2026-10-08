$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$ProgressPreference = 'SilentlyContinue'
function NativeRead($exe, $arguments, $encoding) {
  $info = [Diagnostics.ProcessStartInfo]::new($exe, $arguments)
  $info.UseShellExecute = $false
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = $encoding
  $info.StandardErrorEncoding = $encoding
  $process = [Diagnostics.Process]::Start($info)
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  Write-Output $stdout
  if ($stderr) { Write-Output $stderr }
  Write-Output "exit=$($process.ExitCode)"
  $process.Dispose()
}
function Section($name) { Write-Output "### $name UTC=$([DateTime]::UtcNow.ToString('o'))" }
Section 'OS'
Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,LastBootUpTime | ConvertTo-Json -Compress
Section 'WSL'
NativeRead 'wsl.exe' '--version' ([Text.Encoding]::Unicode)
NativeRead 'wsl.exe' '--status' ([Text.Encoding]::Unicode)
$config = Join-Path $env:USERPROFILE '.wslconfig'
if (Test-Path $config) { Get-Content $config -TotalCount 100 } else { 'No user .wslconfig' }
Section 'Services'
Get-Service W32Time,vmictimesync,WslService -ErrorAction Continue | Select-Object Name,@{n='Status';e={$_.Status.ToString()}},@{n='StartType';e={$_.StartType.ToString()}} | ConvertTo-Json -Compress
Section 'W32Time status'
NativeRead 'w32tm.exe' '/query /status /verbose' ([Text.Encoding]::GetEncoding(949))
Section 'W32Time source'
NativeRead 'w32tm.exe' '/query /source' ([Text.Encoding]::GetEncoding(949))
Section 'W32Time configuration'
NativeRead 'w32tm.exe' '/query /configuration' ([Text.Encoding]::GetEncoding(949))
Section 'W32Time peers'
NativeRead 'w32tm.exe' '/query /peers' ([Text.Encoding]::GetEncoding(949))
Section 'Event logs (last 2 hours; bounded)'
$since = (Get-Date).AddHours(-2)
foreach ($provider in @('Microsoft-Windows-Time-Service','Microsoft-Windows-Kernel-General','Microsoft-Windows-Power-Troubleshooter','Microsoft-Windows-Kernel-Power')) {
  Section $provider
  try {
    Get-WinEvent -FilterHashtable @{LogName='System';ProviderName=$provider;StartTime=$since} -MaxEvents 30 -ErrorAction Stop | ForEach-Object { $_.ToXml() }
  } catch { Write-Output $_.Exception.Message }
}
Section 'Time-Service Operational log'
try {
  Get-WinEvent -ListLog 'Microsoft-Windows-Time-Service/Operational' -ErrorAction Stop | Select-Object LogName,IsEnabled,RecordCount | ConvertTo-Json -Compress
  Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Time-Service/Operational';StartTime=$since} -MaxEvents 30 -ErrorAction Stop | ForEach-Object { $_.ToXml() }
} catch { Write-Output $_.Exception.Message }
Section 'Latest Time-Service Operational events (up to 12, any age)'
try { Get-WinEvent -LogName 'Microsoft-Windows-Time-Service/Operational' -MaxEvents 12 -ErrorAction Stop | ForEach-Object { $_.ToXml() } } catch { Write-Output $_.Exception.Message }
