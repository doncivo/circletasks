# REL-TECH-02 : pilotage de l'interface graphique de l'installeur et du désinstalleur NSIS de fumée.
# Appelé par tests/smoke/pc-installeur.spec.ts ; ne touche QUE au produit de fumée (nom se terminant par « Smoke », dossier d'installation du même nom).
#
#   -Action Reinstall  : lance l'installeur (-Installer) en graphique sur une installation existante dont la version enregistrée est rendue ancienne
#                        (registre, DisplayVersion), choisit « Désinstaller avant d'installer », coche « Supprimer les données de l'application »
#                        dans le désinstalleur, désinstalle, puis déroule l'installation jusqu'à « Terminer » (case de lancement décochée).
#   -Action Uninstall  : lance uninstall.exe (-Installer) en graphique, coche la même case, désinstalle, ferme.
#   -Action Screenshot : capture d'écran de l'état courant (pièce jointe d'un échec du test hors du pilote).
#   -Action Cleanup    : tue les processus de fumée (installeur, désinstalleur, application installée) ; -RemoveRegistry retire les clés de fumée.
#
# Résultat : fichier JSON UTF-8 (-ResultFile) { ok, action, step, message, log[], files[] } ; code de sortie 0 (ok) ou 1 (échec).
# Tout échec nomme l'étape (champ step), joint une capture d'écran, la capture de la fenêtre (window-capture.ps1), la liste des contrôles Win32
# et l'arbre UI Automation (nom, type, identifiant de chaque contrôle) : le libellé d'un bouton changé par Tauri ou NSIS se lit directement dedans.
#
# Pourquoi des messages Win32 et pas des patterns UI Automation : constaté en CI le 2026-10-17 (run 39024162153), UI Automation expose les contrôles
# NSIS comme de simples volets (ControlType.Pane, classe « Button », identifiant = identifiant du contrôle) sans InvokePattern ni TogglePattern.
# Lecture : API Win32 (EnumWindows, EnumChildWindows, WM_GETTEXT, BM_GETCHECK).
# Boutons poussoirs : WM_COMMAND(BN_CLICKED) POSTÉ au dialogue principal avec l'identifiant du bouton (BM_CLICK est resté sans effet sur « Fermer » de la
# page finale en CI, runs 39027366664 et 39027981603). Cases et radios : BM_CLICK, qui bascule leur état (vérifié par BM_GETCHECK). Tout est POSTÉ
# (asynchrone) : sur la page « déjà installé », « Suivant » exécute le désinstalleur (ExecWait) dans le fil de l'interface de l'installeur ; un envoi
# synchrone attendrait la fin d'une désinstallation qu'il faut justement piloter. UI Automation ne sert plus qu'à joindre son arbre au rapport d'échec.
#
# Libellés (modèle NSIS de Tauri 2.12.1, `languages: ["French"]`) :
#   - languages/French.nsh de Tauri : alreadyInstalled « Déja installé. » ; uninstallBeforeInstalling « Désinstaller avant d'installer » ;
#     dontUninstall « Ne pas désinstaller » ; deleteAppData « Supprimer les données de l'application » ;
#     olderOrUnknownVersionInstalled « La version $R4 de ${PRODUCTNAME} est installée sur le système. Il est recommandé de désinstaller... ».
#   - French.nlf de NSIS 3 : ^SetupCaption « Installation de $(^Name) » ; ^UninstallCaption « Désinstallation de $(^Name) » ;
#     ^NextBtn « &Suivant > » ; ^InstallBtn « &Installer » ; ^UninstallBtn « &Désinstaller » ; ^CloseBtn « &Fermer ».
#   - MUI2 : bouton de la page finale « &Terminer » ; case « Exécuter <produit> » (MUI_FINISHPAGE_RUN) ; « Créer un raccourci sur le bureau » (createDesktop).
#   - Page de bienvenue observée en CI : « Bienvenue dans le programme d'installation de CircleTasks Smoke », bouton « Suivant > » (identifiant 1).
# Les motifs ci-dessous sont en ASCII (« D.sinstaller » pour « Désinstaller ») : PowerShell 5.1 lit mal un script sans BOM, le motif ne dépend pas de l'encodage.
#
# Attentes : toujours bornées (Wait-Until : délai maximal, état observable, échec nommant l'étape), jamais de pause fixe.
param(
  [Parameter(Mandatory = $true)][ValidateSet('Reinstall', 'Uninstall', 'Cleanup', 'Screenshot')][string]$Action,
  [Parameter(Mandatory = $true)][string]$ProductName,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [Parameter(Mandatory = $true)][string]$ResultFile,
  [string]$Installer = '',
  [string]$FakeInstalledVersion = '0.0.1',
  [switch]$RemoveRegistry,
  [int]$PageTimeoutMs = 60000,
  [int]$WorkTimeoutMs = 180000,
  # Échéance globale du pilote : dépassée, Wait-Until échoue par le chemin habituel (étape nommée, preuves jointes). Le test la fixe sous sa propre borne
  # (DRIVE_TIMEOUT_MS moins une marge pour les preuves) : spawnSync tuerait PowerShell avant qu'il écrive son résultat.
  [int]$DeadlineMs = 240000
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Text; using System.Runtime.InteropServices;
public class CtCtl { public IntPtr H; public string Cls; public string Text; public int Id; public uint Style; public bool Visible; public bool Enabled; }
public static class CtNsis {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  const uint WM_GETTEXT = 0x000D, BM_GETCHECK = 0x00F0, BM_CLICK = 0x00F5;
  static string Text(IntPtr h) { var sb = new StringBuilder(2048); SendMessage(h, WM_GETTEXT, (IntPtr)sb.Capacity, sb); return sb.ToString(); }
  static string Class(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, sb.Capacity); return sb.ToString(); }
  static CtCtl Describe(IntPtr h) {
    return new CtCtl { H = h, Cls = Class(h), Text = Text(h), Id = GetDlgCtrlID(h), Style = unchecked((uint)GetWindowLong(h, -16)), Visible = IsWindowVisible(h), Enabled = IsWindowEnabled(h) };
  }
  // Fenêtres de premier niveau (visibles ou non : l'installeur se masque pendant la désinstallation) des processus donnés.
  public static List<CtCtl> TopWindows(int[] pids) {
    var list = new List<CtCtl>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (Array.IndexOf(pids, (int)p) >= 0) list.Add(Describe(h)); return true; }, IntPtr.Zero);
    return list;
  }
  // Tous les descendants (page interne de dialogue comprise), dans l'ordre d'énumération.
  public static List<CtCtl> Children(IntPtr parent) {
    var list = new List<CtCtl>();
    EnumChildWindows(parent, (h, l) => { list.Add(Describe(h)); return true; }, IntPtr.Zero);
    return list;
  }
  // Ce que fait un bouton poussoir : WM_COMMAND(BN_CLICKED) vers le dialogue principal (chemin normal des boutons, voir l'en-tête).
  public static void Command(IntPtr button) {
    IntPtr root = button; IntPtr up;
    while ((up = GetParent(root)) != IntPtr.Zero) root = up;
    if (!PostMessage(root, 0x0111, (IntPtr)GetDlgCtrlID(button), button)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
  public static int Check(IntPtr h) { return (int)SendMessage(h, BM_GETCHECK, IntPtr.Zero, IntPtr.Zero); }
  public static void Click(IntPtr h) { if (!PostMessage(h, BM_CLICK, IntPtr.Zero, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
}
'@

$CaptureScript = Join-Path $PSScriptRoot 'window-capture.ps1'
$script:Log = New-Object System.Collections.Generic.List[string]
$script:Files = New-Object System.Collections.Generic.List[string]
$script:Step = 'initialisation'
$script:InstallerProcess = $null
$script:Deadline = [DateTime]::UtcNow.AddMilliseconds($DeadlineMs)

function Enter-Step([string]$Name) {
  $script:Step = $Name
  $script:Log.Add(('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $Name))
}

function Write-Note([string]$Text) {
  $script:Log.Add(('[{0}]   {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $Text))
}

# Attente bornée d'un état observable : $Condition rend une valeur non vide quand l'état est atteint.
function Wait-Until([scriptblock]$Condition, [int]$TimeoutMs, [string]$What) {
  $limit = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ($true) {
    $found = & $Condition
    if ($found) { return $found }
    if ([DateTime]::UtcNow -ge $limit) { throw ('delai de {0} ms depasse : {1}' -f $TimeoutMs, $What) }
    if ([DateTime]::UtcNow -ge $script:Deadline) { throw ('echeance globale du pilote ({0} ms) depassee : {1}' -f $DeadlineMs, $What) }
    Start-Sleep -Milliseconds 250
  }
}

function Format-Name([string]$Text) { return ($Text -replace '&', '').Trim() }

# Garde : seul le produit de fumée est manipulé, jamais l'application réelle.
function Assert-SmokeOnly {
  if ($ProductName -eq 'CircleTasks' -or $ProductName -notmatch ' Smoke$') { throw ("produit refuse (seul un produit « ... Smoke » est manipule) : " + $ProductName) }
  if ((Split-Path -Leaf $InstallDir) -ne $ProductName) { throw ("dossier d'installation refuse (nom different du produit de fumee) : " + $InstallDir) }
  if ((Split-Path -Parent $InstallDir) -ne $env:LOCALAPPDATA) { throw ("dossier d'installation refuse (hors de LOCALAPPDATA) : " + $InstallDir) }
  # Stop-SmokeProcesses tue tout processus dont le chemin est $Installer : installeur de fumee (nom du produit) ou fichier du dossier d'installation.
  if ($Installer) {
    $leaf = Split-Path -Leaf $Installer
    $inside = $Installer.StartsWith($InstallDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
    if (-not $inside -and $leaf -notmatch ('^' + [regex]::Escape($ProductName) + '_.*-setup\.exe$')) { throw ('installeur refuse (ni dans le dossier d installation ni « ' + $ProductName + '_*-setup.exe ») : ' + $Installer) }
  }
}

function Get-ProcessList { return @(Get-CimInstance -ClassName Win32_Process) }

function Test-UnderInstallDir([string]$Path) {
  return ($Path -and $Path.StartsWith($InstallDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))
}

# Processus du désinstalleur : uninstall.exe du dossier d'installation, ou sa copie temporaire Un.exe (lancement sans _?= : observé en CI, Un.exe dans ~nsu*.tmp).
function Get-UninstallerPids {
  $ids = @()
  $expected = Join-Path $InstallDir 'uninstall.exe'
  foreach ($proc in (Get-ProcessList)) {
    $path = [string]$proc.ExecutablePath
    $line = [string]$proc.CommandLine
    $isStub = ($path -and [string]::Equals($path, $expected, [StringComparison]::OrdinalIgnoreCase))
    $isCopy = ($proc.Name -in 'Un.exe', 'Au_.exe' -and $line.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    if ($isStub -or $isCopy) { $ids += [int]$proc.ProcessId }
  }
  return $ids
}

# Fenêtres principales NSIS (#32770 dont le titre contient le nom du produit) des processus donnés.
function Get-ProductWindows([int[]]$ProcessIds) {
  if (-not $ProcessIds -or $ProcessIds.Count -eq 0) { return @() }
  return @([CtNsis]::TopWindows($ProcessIds) | Where-Object { $_.Cls -eq '#32770' -and $_.Text.IndexOf($ProductName, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}

# Contrôles visibles d'une fenêtre. Type d'après le style Win32 : BS_PUSHBUTTON 0/1, BS_CHECKBOX 2/3 (et 3 états 5/6), BS_RADIOBUTTON 4/9.
function Get-Visible($Window) {
  return @([CtNsis]::Children($Window.H) | Where-Object { $_.Visible })
}

function Get-ButtonKind($Control) {
  if ($Control.Cls -ne 'Button') { return '' }
  switch ($Control.Style -band 0xF) {
    { $_ -in 0, 1 } { return 'push' }
    { $_ -in 2, 3, 5, 6 } { return 'check' }
    { $_ -in 4, 9 } { return 'radio' }
    default { return '' }
  }
}

function Find-Control($Window, [string]$Kind, [string]$Pattern, [switch]$EnabledOnly) {
  foreach ($control in (Get-Visible $Window)) {
    if ((Get-ButtonKind $control) -ne $Kind) { continue }
    if ((Format-Name $control.Text) -notmatch $Pattern) { continue }
    if ($EnabledOnly -and -not $control.Enabled) { continue }
    return $control
  }
  return $null
}

# Empreinte de la page : identifiant, texte et activation des contrôles visibles ; change à chaque changement de page ou de bouton.
function Get-Signature($Window) {
  return ((Get-Visible $Window | ForEach-Object { '{0}:{1}:{2}:{3}' -f $_.Id, $_.Cls, (Format-Name $_.Text), $_.Enabled }) -join '|')
}

# Bouton poussoir : WM_COMMAND(BN_CLICKED) vers le dialogue principal (BM_CLICK est resté sans effet sur « Fermer » en CI).
function Send-Click($Control, [string]$What) {
  [CtNsis]::Command($Control.H)
  Write-Note ('clic : ' + $What)
}

function Set-CheckBox($Control, [bool]$Wanted, [string]$What) {
  $target = 0
  if ($Wanted) { $target = 1 }
  if ([CtNsis]::Check($Control.H) -ne $target) { [CtNsis]::Click($Control.H) }
  [void](Wait-Until { [CtNsis]::Check($Control.H) -eq $target } 5000 ('etat de la case « ' + $What + ' » : ' + $target + ' attendu, ' + [CtNsis]::Check($Control.H) + ' observe'))
  Write-Note ('case « ' + $What + ' » : etat ' + [CtNsis]::Check($Control.H))
}

function Set-RadioButton($Control, [string]$What) {
  [CtNsis]::Click($Control.H)
  [void](Wait-Until { [CtNsis]::Check($Control.H) -eq 1 } 5000 ('bouton radio « ' + $What + ' » non selectionne'))
  Write-Note ('bouton radio selectionne : ' + $What)
}

# Dialogue du désinstalleur (confirmation puis désinstallation) : case cochée et vérifiée avant de désinstaller.
function Invoke-UninstallDialog {
  Enter-Step 'desinstalleur : page de confirmation avec la case « Supprimer les donnees de l application »'
  $found = Wait-Until {
    $result = $null
    foreach ($candidate in (Get-ProductWindows (Get-UninstallerPids))) {
      $box = Find-Control $candidate 'check' 'Supprimer les donn'
      if ($box) { $result = [pscustomobject]@{ Window = $candidate; Box = $box }; break }
    }
    $result
  } $PageTimeoutMs 'fenetre du desinstalleur avec la case « Supprimer les donnees de l application »'
  Enter-Step 'desinstalleur : case « Supprimer les donnees de l application » cochee'
  Set-CheckBox $found.Box $true 'Supprimer les donnees de l application'
  Enter-Step 'desinstalleur : bouton « Desinstaller »'
  $button = Find-Control $found.Window 'push' '^D.sinstaller$' -EnabledOnly
  if (-not $button) { throw 'bouton « Desinstaller » introuvable ou inactif sur la page de confirmation' }
  Send-Click $button 'Desinstaller'
  Enter-Step 'desinstalleur : desinstallation en cours puis bouton « Fermer »'
  $outcome = Wait-Until {
    $result = $null
    if (@(Get-UninstallerPids).Count -eq 0) { $result = 'termine' } else {
      foreach ($candidate in (Get-ProductWindows (Get-UninstallerPids))) {
        $close = Find-Control $candidate 'push' '^Fermer$' -EnabledOnly
        if ($close) { $result = $close; break }
      }
    }
    $result
  } $WorkTimeoutMs 'fin de la desinstallation (bouton « Fermer » actif ou fermeture automatique)'
  if ($outcome -ne 'termine') {
    Send-Click $outcome 'Fermer'
    Enter-Step 'desinstalleur : fermeture'
    [void](Wait-Until { if (@(Get-UninstallerPids).Count -eq 0) { 'ferme' } } $PageTimeoutMs 'arret du processus du desinstalleur')
  }
}

function Get-InstallerPage {
  $windows = @(Get-ProductWindows @($script:InstallerProcess.Id))
  if ($windows.Count -eq 0) { return $null }
  $window = $windows[0]
  if (-not $window.Visible) { return $null }
  $radio = Find-Control $window 'radio' 'D.sinstaller avant d.installer'
  if ($radio) { return [pscustomobject]@{ Kind = 'reinstall'; Window = $window; Control = $radio } }
  # Page finale : bouton « Terminer » (MUI) ou « Fermer » (observé en CI le 2026-10-17 avec NOAUTOCLOSE), reconnue à sa case « Lancer <produit> ».
  $finish = Find-Control $window 'push' '^(Terminer|Fermer)$' -EnabledOnly
  if ($finish -and (Find-Control $window 'check' '^(Ex.cuter|Lancer)')) { return [pscustomobject]@{ Kind = 'finish'; Window = $window; Control = $finish } }
  $next = Find-Control $window 'push' '^(Suivant|Installer)' -EnabledOnly
  if ($next) { return [pscustomobject]@{ Kind = 'next'; Window = $window; Control = $next } }
  return $null
}

function Invoke-ReinstallFlow {
  if (-not (Test-Path -LiteralPath $Installer)) { throw ('installeur introuvable : ' + $Installer) }
  Enter-Step 'preparation : version enregistree rendue ancienne (page « Desinstaller avant d installer »)'
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $ProductName
  if (-not (Test-Path -LiteralPath $key)) { throw ('entree de desinstallation introuvable : ' + $key + ' (installation silencieuse non faite ?)') }
  Set-ItemProperty -LiteralPath $key -Name 'DisplayVersion' -Value $FakeInstalledVersion
  Write-Note ('DisplayVersion = ' + $FakeInstalledVersion)

  Enter-Step 'installeur : lancement en mode graphique'
  $script:InstallerProcess = Start-Process -FilePath $Installer -PassThru
  $reinstalled = $false
  $finished = $false
  for ($index = 1; $index -le 16 -and -not $finished; $index++) {
    Enter-Step ('installeur : page ' + $index)
    $page = Wait-Until { Get-InstallerPage } $WorkTimeoutMs ('page de l installeur (page ' + $index + ')')
    Save-Screen ('installeur-page-' + $index)
    Write-Note ('page ' + $index + ' (' + $page.Kind + ') : ' + (Get-Signature $page.Window))
    switch ($page.Kind) {
      'reinstall' {
        Enter-Step 'installeur : page « Deja installe », choix « Desinstaller avant d installer »'
        Set-RadioButton $page.Control 'Desinstaller avant d installer'
        $next = Find-Control $page.Window 'push' '^Suivant' -EnabledOnly
        if (-not $next) { throw 'bouton « Suivant » introuvable ou inactif sur la page « Deja installe »' }
        Send-Click $next 'Suivant (page Deja installe)'
        Invoke-UninstallDialog
        $reinstalled = $true
        Enter-Step 'installeur : reprise apres la desinstallation'
      }
      'finish' {
        Enter-Step 'installeur : page finale (case de lancement decochee, bouton « Terminer »)'
        $run = Find-Control $page.Window 'check' '^(Ex.cuter|Lancer)'
        if ($run) { Set-CheckBox $run $false 'Executer l application' } else { Write-Note 'case de lancement absente de la page finale' }
        # BM_CLICK reste sans effet sur « Fermer » de la page finale (runs 39027366664, 39027981603 : installeur actif et répondant), alors que
        # WM_COMMAND(BN_CLICKED) envoyé au dialogue principal, ce que fait réellement un bouton, ferme l'installeur (run 39028571800).
        [CtNsis]::Command($page.Control.H)
        Write-Note ('commande envoyee : ' + (Format-Name $page.Control.Text))
        Enter-Step 'installeur : fin du processus'
        [void](Wait-Until { $script:InstallerProcess.Refresh(); if ($script:InstallerProcess.HasExited) { 'ferme' } } $PageTimeoutMs ('arret de l installeur apres « ' + (Format-Name $page.Control.Text) + ' » (Responding=' + $script:InstallerProcess.Responding + ')'))
        if ($script:InstallerProcess.ExitCode -ne 0) { throw ('code de sortie de l installeur : ' + $script:InstallerProcess.ExitCode) }
        $finished = $true
      }
      default {
        $signature = Get-Signature $page.Window
        Send-Click $page.Control ('page ' + $index + ' : ' + (Format-Name $page.Control.Text))
        Enter-Step ('installeur : changement de la page ' + $index)
        [void](Wait-Until {
          $current = @(Get-ProductWindows @($script:InstallerProcess.Id))
          if ($current.Count -gt 0 -and (Get-Signature $current[0]) -ne $signature) { 'change' }
        } $WorkTimeoutMs ('changement de page apres le clic (page ' + $index + ')'))
      }
    }
  }
  if (-not $reinstalled) { throw 'la page « Desinstaller avant d installer » n a jamais ete rencontree' }
  if (-not $finished) { throw 'la page finale « Terminer » n a pas ete atteinte en 16 pages' }
}

function Invoke-UninstallFlow {
  if (-not (Test-Path -LiteralPath $Installer)) { throw ('desinstalleur introuvable : ' + $Installer) }
  Enter-Step 'desinstalleur : lancement en mode graphique'
  $script:InstallerProcess = Start-Process -FilePath $Installer -PassThru
  Invoke-UninstallDialog
}

function Stop-SmokeProcesses {
  Enter-Step 'nettoyage : processus de fumee'
  $targets = @()
  foreach ($proc in (Get-ProcessList)) {
    $path = [string]$proc.ExecutablePath
    $line = [string]$proc.CommandLine
    $match = (Test-UnderInstallDir $path) -or ($Installer -and $path -and [string]::Equals($path, $Installer, [StringComparison]::OrdinalIgnoreCase)) -or
      ($proc.Name -in 'Un.exe', 'Au_.exe' -and $line.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    if ($match -and $proc.ProcessId -ne $PID) { $targets += $proc }
  }
  foreach ($proc in $targets) {
    try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop; Write-Note ('processus arrete : ' + $proc.Name + ' (' + $proc.ProcessId + ')') }
    catch { Write-Note ('processus ' + $proc.Name + ' (' + $proc.ProcessId + ') : ' + $_.Exception.Message) }
  }
  foreach ($proc in $targets) {
    [void](Wait-Until { if (-not (Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue)) { 'arrete' } } $PageTimeoutMs ('arret du processus ' + $proc.Name + ' (' + $proc.ProcessId + ')'))
  }
  if ($RemoveRegistry) {
    Enter-Step 'nettoyage : cles de registre de fumee'
    $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $ProductName
    if (Test-Path -LiteralPath $uninstallKey) { Remove-Item -LiteralPath $uninstallKey -Recurse -Force; Write-Note ('cle supprimee : ' + $uninstallKey) }
    foreach ($vendor in (Get-ChildItem -LiteralPath 'HKCU:\Software')) {
      $productKey = Join-Path $vendor.PSPath $ProductName
      if (Test-Path -LiteralPath $productKey) { Remove-Item -LiteralPath $productKey -Recurse -Force; Write-Note ('cle supprimee : ' + $productKey) }
    }
  }
}

# Capture d'écran de tout le bureau, jointe au résultat (une par page de l'installeur : le prochain échec se lit sans rejouer).
function Save-Screen([string]$Name) {
  try {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $file = Join-Path $OutDir (($Action.ToLowerInvariant()) + '-' + $Name + '.png')
    $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bitmap.Dispose()
    $script:Files.Add($file)
  } catch { Write-Note ('capture d ecran impossible : ' + $_.Exception.Message) }
}

# Échec : capture d'écran, capture de la fenêtre (window-capture.ps1), contrôles Win32 et arbre UI Automation, joints au résultat.
function Save-FailureEvidence {
  $stamp = $Action.ToLowerInvariant()
  try {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $screen = Join-Path $OutDir ($stamp + '-echec-ecran.png')
    $bitmap.Save($screen, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bitmap.Dispose()
    $script:Files.Add($screen)
  } catch { Write-Note ('capture d ecran impossible : ' + $_.Exception.Message) }
  try {
    $ids = @(Get-UninstallerPids)
    if ($script:InstallerProcess) { $ids += $script:InstallerProcess.Id }
    $dump = New-Object System.Text.StringBuilder
    if ($script:InstallerProcess) {
      foreach ($child in (Get-ProcessList | Where-Object { $_.ParentProcessId -eq $script:InstallerProcess.Id })) { [void]$dump.AppendLine(('PROCESSUS FILS pid={0} nom={1} ligne={2}' -f $child.ProcessId, $child.Name, $child.CommandLine)) }
      [void]$dump.AppendLine(('INSTALLEUR pid={0} termine={1} repond={2}' -f $script:InstallerProcess.Id, $script:InstallerProcess.HasExited, $script:InstallerProcess.Responding))
    }
    $captured = 0
    foreach ($window in @(Get-ProductWindows $ids)) {
      [void]$dump.AppendLine(('FENETRE WIN32 h={0} classe={1} titre=« {2} » visible={3}' -f $window.H, $window.Cls, $window.Text, $window.Visible))
      foreach ($control in @([CtNsis]::Children($window.H))) {
        $state = ''
        if ((Get-ButtonKind $control) -in 'check', 'radio') { $state = ' etat=' + [CtNsis]::Check($control.H) }
        [void]$dump.AppendLine(('  classe={0} id={1} style=0x{2:X8} type={3} visible={4} actif={5}{6} texte=« {7} »' -f $control.Cls, $control.Id, $control.Style, (Get-ButtonKind $control), $control.Visible, $control.Enabled, $state, $control.Text))
      }
      if ($captured -lt 2) {
        $captured++
        $owner = 0
        foreach ($processId in $ids) { if (@([CtNsis]::TopWindows(@($processId)) | Where-Object { $_.H -eq $window.H }).Count -gt 0) { $owner = $processId } }
        $png = Join-Path $OutDir ($stamp + '-echec-fenetre-' + $captured + '.png')
        $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $CaptureScript -ProcessId $owner -Out $png -Title $window.Text 2>&1 | Out-String
        Write-Note ('window-capture.ps1 : ' + $output.Trim())
        if (Test-Path -LiteralPath $png) { $script:Files.Add($png) }
      }
    }
    $Auto = [System.Windows.Automation.AutomationElement]
    $Scope = [System.Windows.Automation.TreeScope]
    foreach ($processId in $ids) {
      $condition = New-Object System.Windows.Automation.PropertyCondition($Auto::ProcessIdProperty, $processId)
      foreach ($window in $Auto::RootElement.FindAll($Scope::Children, $condition)) {
        [void]$dump.AppendLine(('FENETRE UIA pid={0} classe={1} nom=« {2} » horsEcran={3}' -f $processId, $window.Current.ClassName, $window.Current.Name, $window.Current.IsOffscreen))
        foreach ($element in $window.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
          [void]$dump.AppendLine(('  {0} nom=« {1} » id={2} classe={3} actif={4}' -f $element.Current.ControlType.ProgrammaticName, $element.Current.Name, $element.Current.AutomationId, $element.Current.ClassName, $element.Current.IsEnabled))
        }
      }
    }
    $tree = Join-Path $OutDir ($stamp + '-echec-arbre.txt')
    [System.IO.File]::WriteAllText($tree, $dump.ToString(), [System.Text.Encoding]::UTF8)
    $script:Files.Add($tree)
  } catch { Write-Note ('arbre des controles impossible : ' + $_.Exception.Message) }
}

$ok = $false
$message = ''
try {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  Assert-SmokeOnly
  switch ($Action) {
    'Reinstall' { Invoke-ReinstallFlow }
    'Uninstall' { Invoke-UninstallFlow }
    'Cleanup' { Stop-SmokeProcesses }
    'Screenshot' { Save-Screen 'etat' }
  }
  $ok = $true
} catch {
  $message = $_.Exception.Message
  Write-Note ('ECHEC a l etape « ' + $script:Step + ' » : ' + $message)
  if ($Action -ne 'Cleanup') { Save-FailureEvidence }
}
$result = [ordered]@{ ok = $ok; action = $Action; step = $script:Step; message = $message; log = @($script:Log); files = @($script:Files) }
[System.IO.File]::WriteAllText($ResultFile, ($result | ConvertTo-Json -Compress -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
if (-not $ok) { exit 1 }
exit 0
