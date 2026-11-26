# Asks a HID collection for one input report and prints it as a hex line.
# For devices that only hand their battery over when asked (HidD_GetInputReport), and that have no
# output report to send a request with. node-hid doesn't expose HidD_GetInputReport.
param([string]$Path, [int]$ReportId, [int]$Size)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class HidInput {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("hid.dll", SetLastError = true)]
  public static extern bool HidD_GetInputReport(SafeFileHandle h, byte[] buffer, int length);
}
'@
$handle = [HidInput]::CreateFile($Path, 0xC0000000L, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
if ($handle.IsInvalid) { exit 2 }
try {
  $report = New-Object byte[] ($Size)
  $report[0] = [byte]$ReportId
  if (-not [HidInput]::HidD_GetInputReport($handle, $report, $Size)) { exit 3 }
  [Console]::Out.WriteLine(($report | ForEach-Object { $_.ToString('x2') }) -join '')
} finally {
  $handle.Dispose()
}
