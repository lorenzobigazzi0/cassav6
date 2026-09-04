<#
  Arresto dei servizi Cassa V5BT avviati da start-v5bt-windows.ps1.
  MySQL di XAMPP non viene fermato.
#>
$ErrorActionPreference = "Stop"

$ports = @(5380, 5381, 8865, 9390, 9391, 9299, 9201, 9202, 9203, 9204)
foreach ($port in $ports) {
  foreach ($listener in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
    $pidValue = [int]$listener.OwningProcess
    if ($pidValue -le 0 -or $pidValue -eq $PID) { continue }
    try {
      Stop-Process -Id $pidValue -Force -ErrorAction Stop
      Write-Output ("Porta {0}: terminato pid {1}" -f $port, $pidValue)
    } catch {
      Write-Output ("Porta {0}: impossibile terminare pid {1}" -f $port, $pidValue)
    }
  }
}
Write-Output "Servizi V5BT arrestati."
