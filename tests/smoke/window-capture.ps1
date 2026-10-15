# REL-TECH-01 (ADR 0016) : capture de la fenêtre principale de CircleTasks (Win32, PrintWindow avec PW_RENDERFULLCONTENT : contenu composé de
# WebView2, fenêtre au premier plan ou non). Le script ne fait QUE capturer : la mesure des pixels est en Node (tests/smoke/pixels.ts), car les
# boucles PowerShell et son démarrage à froid sur un runner chargé ont dépassé 60 s puis 120 s le 2026-10-15.
#   -ProcessId <pid> -Out <png>   enregistre le PNG de la fenêtre « CircleTasks » du processus et rend une ligne JSON :
#   found, visible, iconic, width, height (fenêtre entière), clientX, clientY, clientWidth, clientHeight (zone cliente dans le PNG), printed, elapsedMs.
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Title = 'CircleTasks'
)
$ErrorActionPreference = 'Stop'
$started = [DateTime]::UtcNow
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class CtSmokeWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static IntPtr Find(uint pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); if (sb.ToString() == title) { found = h; return false; } }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
# Coordonnées physiques (écran mis à l'échelle en local) : DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4) ; refus (déjà fixé) sans effet.
[void][CtSmokeWin]::SetProcessDpiAwarenessContext([IntPtr]::op_Explicit(-4))
$h = [CtSmokeWin]::Find([uint32]$ProcessId, $Title)
$result = [ordered]@{ found = ($h -ne [IntPtr]::Zero); visible = $false; iconic = $false; width = 0; height = 0; clientX = 0; clientY = 0; clientWidth = 0; clientHeight = 0; printed = $false; elapsedMs = 0 }
if ($result.found) {
  $result.visible = [CtSmokeWin]::IsWindowVisible($h)
  $result.iconic = [CtSmokeWin]::IsIconic($h)
  $r = New-Object CtSmokeWin+RECT
  [void][CtSmokeWin]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
  $result.width = $w; $result.height = $hh
  $cr = New-Object CtSmokeWin+RECT
  [void][CtSmokeWin]::GetClientRect($h, [ref]$cr)
  $origin = New-Object CtSmokeWin+POINT
  [void][CtSmokeWin]::ClientToScreen($h, [ref]$origin)
  $result.clientX = $origin.X - $r.Left; $result.clientY = $origin.Y - $r.Top
  $result.clientWidth = $cr.Right - $cr.Left; $result.clientHeight = $cr.Bottom - $cr.Top
  if ($w -gt 0 -and $hh -gt 0) {
    $bmp = New-Object System.Drawing.Bitmap $w, $hh
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    try { $result.printed = [CtSmokeWin]::PrintWindow($h, $hdc, 2) } finally { $g.ReleaseHdc($hdc); $g.Dispose() }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  }
}
$result.elapsedMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
$result | ConvertTo-Json -Compress
