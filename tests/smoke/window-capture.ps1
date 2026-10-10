# REL-TECH-01 (ADR 0016) : pixels réels de la fenêtre principale de CircleTasks (Win32, PrintWindow avec PW_RENDERFULLCONTENT :
# contenu composé de WebView2, fenêtre au premier plan ou non). Sortie : une ligne JSON.
#   -ProcessId <pid> -Out <png>   capture la fenêtre « CircleTasks » du processus, enregistre le PNG, rend les statistiques de la ZONE CLIENTE
#                                 (sans cadre ni barre de titre : une barre de titre claire ne masque jamais une WebView noire).
#   -SelfTest                     mesure une image noire, une image noire sous une barre de titre claire (zone cliente seule) et une image au
#                                 thème sombre de l'app : preuve que le contrôle voit un écran noir et accepte l'app.
# Statistiques : pixels échantillonnés tous les 16 px ; `nearBlack` = max(R,G,B) < 12 (le fond sombre de l'app, vers (26,21,48), n'est jamais compté) ;
# `distinct` = couleurs distinctes (quantifiées à 4 bits par canal).
param(
  [int]$ProcessId = 0,
  [string]$Out = '',
  [string]$Title = 'CircleTasks',
  [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'
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

# Mesure d'une zone [x0, x0+w) × [y0, y0+h) d'un bitmap.
function Measure-Region([System.Drawing.Bitmap]$bmp, [int]$x0, [int]$y0, [int]$w, [int]$h) {
  $stats = [ordered]@{ sampled = 0; nearBlack = 0; distinct = 0 }
  $colors = New-Object 'System.Collections.Generic.HashSet[int]'
  $xMax = [Math]::Min($bmp.Width, $x0 + $w); $yMax = [Math]::Min($bmp.Height, $y0 + $h)
  for ($y = $y0 + 8; $y -lt $yMax; $y += 16) {
    for ($x = $x0 + 8; $x -lt $xMax; $x += 16) {
      $c = $bmp.GetPixel($x, $y)
      $stats.sampled++
      if ([Math]::Max($c.R, [Math]::Max($c.G, $c.B)) -lt 12) { $stats.nearBlack++ }
      [void]$colors.Add(((($c.R -shr 4) -shl 8) -bor (($c.G -shr 4) -shl 4)) -bor ($c.B -shr 4))
    }
  }
  $stats.distinct = $colors.Count
  return $stats
}

if ($SelfTest) {
  $black = New-Object System.Drawing.Bitmap 1200, 800
  $gb = [System.Drawing.Graphics]::FromImage($black); $gb.Clear([System.Drawing.Color]::Black); $gb.Dispose()
  # Fenêtre noire sous une barre de titre claire de 31 px : la zone cliente (sous la barre) est entièrement noire.
  $barred = New-Object System.Drawing.Bitmap 1200, 800
  $gr = [System.Drawing.Graphics]::FromImage($barred); $gr.Clear([System.Drawing.Color]::Black); $gr.FillRectangle([System.Drawing.Brushes]::White, 0, 0, 1200, 31); $gr.Dispose()
  $app = New-Object System.Drawing.Bitmap 1200, 800
  $ga = [System.Drawing.Graphics]::FromImage($app)
  $ga.Clear([System.Drawing.Color]::FromArgb(26, 21, 48))
  $ga.FillRectangle([System.Drawing.Brushes]::White, 100, 100, 600, 80)
  $ga.Dispose()
  $result = [ordered]@{
    black = (Measure-Region $black 0 0 1200 800)
    barredWhole = (Measure-Region $barred 0 0 1200 800)
    barredClient = (Measure-Region $barred 0 31 1200 769)
    app = (Measure-Region $app 0 0 1200 800)
  }
  $black.Dispose(); $barred.Dispose(); $app.Dispose()
  $result | ConvertTo-Json -Compress
  exit 0
}

if ($ProcessId -le 0 -or $Out -eq '') { throw 'Usage : -ProcessId <pid> -Out <png> | -SelfTest' }
# Coordonnées physiques (écran mis à l'échelle en local) : DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4) ; refus (déjà fixé) sans effet.
[void][CtSmokeWin]::SetProcessDpiAwarenessContext([IntPtr]::op_Explicit(-4))
$h = [CtSmokeWin]::Find([uint32]$ProcessId, $Title)
$result = [ordered]@{ found = ($h -ne [IntPtr]::Zero); visible = $false; iconic = $false; width = 0; height = 0; clientWidth = 0; clientHeight = 0; printed = $false; sampled = 0; nearBlack = 0; distinct = 0 }
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
  $cw = $cr.Right - $cr.Left; $ch = $cr.Bottom - $cr.Top
  $result.clientWidth = $cw; $result.clientHeight = $ch
  if ($w -gt 0 -and $hh -gt 0) {
    $bmp = New-Object System.Drawing.Bitmap $w, $hh
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    try { $result.printed = [CtSmokeWin]::PrintWindow($h, $hdc, 2) } finally { $g.ReleaseHdc($hdc); $g.Dispose() }
    if ($cw -gt 0 -and $ch -gt 0) {
      $stats = Measure-Region $bmp ($origin.X - $r.Left) ($origin.Y - $r.Top) $cw $ch
      $result.sampled = $stats.sampled; $result.nearBlack = $stats.nearBlack; $result.distinct = $stats.distinct
    }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  }
}
$result | ConvertTo-Json -Compress
