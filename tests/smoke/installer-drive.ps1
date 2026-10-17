# REL-TECH-02 : pilotage de l'interface graphique de l'installeur et du désinstalleur NSIS de fumée par UI Automation (System.Windows.Automation).
# Appelé par tests/smoke/pc-installeur.spec.ts ; ne touche QUE au produit de fumée (nom se terminant par « Smoke », dossier d'installation du même nom).
#
#   -Action Reinstall  : lance l'installeur (-Installer) en graphique sur une installation existante dont la version enregistrée est rendue ancienne
#                        (registre, DisplayVersion), choisit « Désinstaller avant d'installer », coche « Supprimer les données de l'application »
#                        dans le désinstalleur, désinstalle, puis déroule l'installation jusqu'à « Terminer » (case de lancement décochée).
#   -Action Uninstall  : lance uninstall.exe (-Installer) en graphique, coche la même case, désinstalle, ferme.
#   -Action Cleanup    : tue les processus de fumée (installeur, désinstalleur, application installée) ; -RemoveRegistry retire les clés de fumée.
#
# Résultat : fichier JSON UTF-8 (-ResultFile) { ok, action, step, message, log[], files[] } ; code de sortie 0 (ok) ou 1 (échec).
# Tout échec nomme l'étape (champ step), joint une capture d'écran, la capture de la fenêtre (window-capture.ps1) et l'arbre UI Automation
# (nom, type, état de chaque contrôle) : le libellé d'un bouton changé par Tauri ou NSIS se lit directement dans l'arbre.
#
# Libellés (modèle NSIS de Tauri 2.12.1, `languages: ["French"]`) :
#   - languages/French.nsh de Tauri : alreadyInstalled « Déja installé. » ; uninstallBeforeInstalling « Désinstaller avant d'installer » ;
#     dontUninstall « Ne pas désinstaller » ; deleteAppData « Supprimer les données de l'application » ;
#     olderOrUnknownVersionInstalled « La version $R4 de ${PRODUCTNAME} est installée sur le système. Il est recommandé de désinstaller... ».
#   - French.nlf de NSIS 3 : ^SetupCaption « Installation de $(^Name) » ; ^UninstallCaption « Désinstallation de $(^Name) » ;
#     ^NextBtn « &Suivant > » ; ^InstallBtn « &Installer » ; ^UninstallBtn « &Désinstaller » ; ^CloseBtn « &Fermer ».
#   - MUI2 : bouton de la page finale « &Terminer » ; case « Exécuter <produit> » (MUI_FINISHPAGE_RUN) ; « Créer un raccourci sur le bureau » (createDesktop).
# Les motifs ci-dessous sont en ASCII (« D.sinstaller » pour « Désinstaller ») : PowerShell 5.1 lit mal un script sans BOM, le motif ne dépend pas de l'encodage.
#
# Attentes : toujours bornées (Wait-Until : délai maximal, état observable, échec nommant l'étape), jamais de pause fixe. Les clics sont
# envoyés dans un autre runspace : sur la page « déjà installé », « Suivant » exécute le désinstalleur (ExecWait) dans le fil de l'interface
# de l'installeur, donc un clic synchrone attendrait la fin d'une désinstallation qu'il faut justement piloter.
param(
  [Parameter(Mandatory = $true)][ValidateSet('Reinstall', 'Uninstall', 'Cleanup')][string]$Action,
  [Parameter(Mandatory = $true)][string]$ProductName,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [Parameter(Mandatory = $true)][string]$ResultFile,
  [string]$Installer = '',
  [string]$FakeInstalledVersion = '0.0.1',
  [switch]$RemoveRegistry,
  [int]$PageTimeoutMs = 60000,
  [int]$WorkTimeoutMs = 180000
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$CaptureScript = Join-Path $PSScriptRoot 'window-capture.ps1'
$Auto = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$script:Log = New-Object System.Collections.Generic.List[string]
$script:Files = New-Object System.Collections.Generic.List[string]
$script:Pending = New-Object System.Collections.Generic.List[object]
$script:Step = 'initialisation'
$script:InstallerProcess = $null

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
    $found = $null
    try { $found = & $Condition } catch [System.Windows.Automation.ElementNotAvailableException] { $found = $null }
    if ($found) { return $found }
    if ([DateTime]::UtcNow -ge $limit) { throw ('delai de {0} ms depasse : {1}' -f $TimeoutMs, $What) }
    Start-Sleep -Milliseconds 250
  }
}

function Format-Name([string]$Text) { return ($Text -replace '&', '').Trim() }

# Garde : seul le produit de fumée est manipulé, jamais l'application réelle.
function Assert-SmokeOnly {
  if ($ProductName -eq 'CircleTasks' -or $ProductName -notmatch ' Smoke$') { throw ("produit refuse (seul un produit « ... Smoke » est manipule) : " + $ProductName) }
  if ((Split-Path -Leaf $InstallDir) -ne $ProductName) { throw ("dossier d'installation refuse (nom different du produit de fumee) : " + $InstallDir) }
}

function Get-ProcessList { return @(Get-CimInstance -ClassName Win32_Process) }

function Test-UnderInstallDir([string]$Path) {
  return ($Path -and $Path.StartsWith($InstallDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))
}

# Processus du désinstalleur : uninstall.exe du dossier d'installation, ou sa copie temporaire Au_.exe (lancement sans _?=).
function Get-UninstallerPids {
  $ids = @()
  $expected = Join-Path $InstallDir 'uninstall.exe'
  foreach ($proc in (Get-ProcessList)) {
    $path = [string]$proc.ExecutablePath
    $line = [string]$proc.CommandLine
    $isStub = ($path -and [string]::Equals($path, $expected, [StringComparison]::OrdinalIgnoreCase))
    $isCopy = ($proc.Name -eq 'Au_.exe' -and $line.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    if ($isStub -or $isCopy) { $ids += [int]$proc.ProcessId }
  }
  return $ids
}

# Fenêtres de dialogue (#32770) des processus donnés dont le titre contient le nom du produit.
function Get-ProductWindows([int[]]$ProcessIds) {
  $windows = @()
  foreach ($processId in $ProcessIds) {
    $condition = New-Object System.Windows.Automation.PropertyCondition($Auto::ProcessIdProperty, $processId)
    foreach ($window in $Auto::RootElement.FindAll($Scope::Children, $condition)) {
      if ($window.Current.ClassName -eq '#32770' -and $window.Current.Name.IndexOf($ProductName, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $windows += $window }
    }
  }
  return $windows
}

function Find-Control($Window, $ControlType, [string]$Pattern, [switch]$EnabledOnly) {
  $condition = New-Object System.Windows.Automation.PropertyCondition($Auto::ControlTypeProperty, $ControlType)
  foreach ($element in $Window.FindAll($Scope::Descendants, $condition)) {
    if ((Format-Name $element.Current.Name) -match $Pattern) {
      if ((-not $EnabledOnly) -or $element.Current.IsEnabled) { return $element }
    }
  }
  return $null
}

# Empreinte de la page : type, nom et état d'activation de tous les contrôles ; change à chaque changement de page ou de bouton.
function Get-Signature($Window) {
  $parts = @()
  foreach ($element in $Window.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    $parts += ('{0}:{1}:{2}' -f $element.Current.ControlType.ProgrammaticName, (Format-Name $element.Current.Name), $element.Current.IsEnabled)
  }
  return ($parts -join '|')
}

function Send-Click($Element, [string]$What) {
  $pattern = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $shell = [PowerShell]::Create()
  [void]$shell.AddScript('param($p) $p.Invoke()').AddArgument($pattern)
  $script:Pending.Add(@{ Shell = $shell; Handle = $shell.BeginInvoke(); What = $What })
  Write-Note ('clic : ' + $What)
}

function Set-CheckBox($Element, [bool]$Wanted, [string]$What) {
  $toggle = $Element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  $target = [System.Windows.Automation.ToggleState]::Off
  if ($Wanted) { $target = [System.Windows.Automation.ToggleState]::On }
  if ($toggle.Current.ToggleState -ne $target) { $toggle.Toggle() }
  [void](Wait-Until { $toggle.Current.ToggleState -eq $target } 5000 ('etat de la case « ' + $What + ' » : ' + $target + ' attendu, ' + $toggle.Current.ToggleState + ' observe'))
  Write-Note ('case « ' + $What + ' » : ' + $toggle.Current.ToggleState)
}

function Set-RadioButton($Element, [string]$What) {
  $selection = $Element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  $selection.Select()
  [void](Wait-Until { $selection.Current.IsSelected } 5000 ('bouton radio « ' + $What + ' » non selectionne'))
  Write-Note ('bouton radio selectionne : ' + $What)
}

# Les clics terminés doivent l'avoir été sans erreur inattendue ; ceux qui restent bloqués sont arrêtés et signalés.
function Complete-Pending {
  foreach ($click in $script:Pending) {
    $shell = $click.Shell
    try {
      if ($click.Handle.IsCompleted) {
        try { $shell.EndInvoke($click.Handle) | Out-Null } catch { Write-Note ('clic « ' + $click.What + ' » : ' + $_.Exception.Message) }
      } else {
        Write-Note ('clic « ' + $click.What + ' » toujours en cours a la fin du script (fenetre fermee avant le retour du clic)')
        $shell.Stop()
      }
    } finally { $shell.Dispose() }
  }
  $script:Pending.Clear()
}

# Dialogue du désinstalleur (confirmation puis désinstallation) : case cochée et vérifiée avant de désinstaller.
function Invoke-UninstallDialog {
  Enter-Step 'desinstalleur : page de confirmation avec la case « Supprimer les donnees de l application »'
  $window = Wait-Until {
    $found = $null
    foreach ($candidate in @(Get-ProductWindows (Get-UninstallerPids))) {
      if (Find-Control $candidate ([System.Windows.Automation.ControlType]::CheckBox) 'Supprimer les donn') { $found = $candidate; break }
    }
    $found
  } $PageTimeoutMs 'fenetre du desinstalleur avec la case « Supprimer les donnees de l application »'
  $box = Find-Control $window ([System.Windows.Automation.ControlType]::CheckBox) 'Supprimer les donn'
  Enter-Step 'desinstalleur : case « Supprimer les donnees de l application » cochee'
  Set-CheckBox $box $true 'Supprimer les donnees de l application'
  Enter-Step 'desinstalleur : bouton « Desinstaller »'
  $button = Find-Control $window ([System.Windows.Automation.ControlType]::Button) '^D.sinstaller$' -EnabledOnly
  if (-not $button) { throw 'bouton « Desinstaller » introuvable ou inactif sur la page de confirmation' }
  Send-Click $button 'Desinstaller'
  Enter-Step 'desinstalleur : desinstallation en cours puis bouton « Fermer »'
  $outcome = Wait-Until {
    $result = $null
    if (@(Get-UninstallerPids).Count -eq 0) { $result = 'termine' } else {
      foreach ($candidate in @(Get-ProductWindows (Get-UninstallerPids))) {
        $close = Find-Control $candidate ([System.Windows.Automation.ControlType]::Button) '^Fermer$' -EnabledOnly
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
  $radio = Find-Control $window ([System.Windows.Automation.ControlType]::RadioButton) 'D.sinstaller avant d.installer'
  if ($radio) { return [pscustomobject]@{ Kind = 'reinstall'; Window = $window; Control = $radio } }
  $finish = Find-Control $window ([System.Windows.Automation.ControlType]::Button) '^Terminer$' -EnabledOnly
  if ($finish) { return [pscustomobject]@{ Kind = 'finish'; Window = $window; Control = $finish } }
  $next = Find-Control $window ([System.Windows.Automation.ControlType]::Button) '^(Suivant|Installer)' -EnabledOnly
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
    switch ($page.Kind) {
      'reinstall' {
        Enter-Step 'installeur : page « Deja installe », choix « Desinstaller avant d installer »'
        Set-RadioButton $page.Control 'Desinstaller avant d installer'
        $next = Find-Control $page.Window ([System.Windows.Automation.ControlType]::Button) '^Suivant' -EnabledOnly
        if (-not $next) { throw 'bouton « Suivant » introuvable ou inactif sur la page « Deja installe »' }
        Send-Click $next 'Suivant (page Deja installe)'
        Invoke-UninstallDialog
        $reinstalled = $true
        Enter-Step 'installeur : reprise apres la desinstallation'
      }
      'finish' {
        Enter-Step 'installeur : page finale (case de lancement decochee, bouton « Terminer »)'
        $run = Find-Control $page.Window ([System.Windows.Automation.ControlType]::CheckBox) '^(Ex.cuter|Lancer)'
        if ($run) { Set-CheckBox $run $false 'Executer l application' } else { Write-Note 'case de lancement absente de la page finale' }
        Send-Click $page.Control 'Terminer'
        Enter-Step 'installeur : fin du processus'
        [void](Wait-Until { $script:InstallerProcess.Refresh(); if ($script:InstallerProcess.HasExited) { 'ferme' } } $PageTimeoutMs 'arret de l installeur apres « Terminer »')
        if ($script:InstallerProcess.ExitCode -ne 0) { throw ('code de sortie de l installeur : ' + $script:InstallerProcess.ExitCode) }
        $finished = $true
      }
      default {
        $signature = Get-Signature $page.Window
        Send-Click $page.Control ('page ' + $index + ' : ' + (Format-Name $page.Control.Current.Name))
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
      ($proc.Name -eq 'Au_.exe' -and $line.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0)
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

# Échec : capture d'écran, capture de la fenêtre (window-capture.ps1) et arbre UI Automation, joints au résultat.
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
    $captured = 0
    foreach ($processId in $ids) {
      $condition = New-Object System.Windows.Automation.PropertyCondition($Auto::ProcessIdProperty, $processId)
      foreach ($window in $Auto::RootElement.FindAll($Scope::Children, $condition)) {
        [void]$dump.AppendLine(('FENETRE pid={0} classe={1} nom=« {2} » horsEcran={3}' -f $processId, $window.Current.ClassName, $window.Current.Name, $window.Current.IsOffscreen))
        foreach ($element in $window.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
          $state = ''
          try { $state = ' coche=' + $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState } catch { $state = '' }
          if (-not $state) { try { $state = ' selectionne=' + $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected } catch { $state = '' } }
          [void]$dump.AppendLine(('  {0} nom=« {1} » id={2} classe={3} actif={4}{5}' -f $element.Current.ControlType.ProgrammaticName, $element.Current.Name, $element.Current.AutomationId, $element.Current.ClassName, $element.Current.IsEnabled, $state))
        }
        if ($window.Current.ClassName -eq '#32770' -and $captured -lt 2) {
          $captured++
          $png = Join-Path $OutDir ($stamp + '-echec-fenetre-' + $captured + '.png')
          $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $CaptureScript -ProcessId $processId -Out $png -Title $window.Current.Name 2>&1 | Out-String
          Write-Note ('window-capture.ps1 : ' + $output.Trim())
          if (Test-Path -LiteralPath $png) { $script:Files.Add($png) }
        }
      }
    }
    $tree = Join-Path $OutDir ($stamp + '-echec-arbre.txt')
    [System.IO.File]::WriteAllText($tree, $dump.ToString(), [System.Text.Encoding]::UTF8)
    $script:Files.Add($tree)
  } catch { Write-Note ('arbre UI Automation impossible : ' + $_.Exception.Message) }
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
  }
  $ok = $true
} catch {
  $message = $_.Exception.Message
  Write-Note ('ECHEC a l etape « ' + $script:Step + ' » : ' + $message)
  if ($Action -ne 'Cleanup') { Save-FailureEvidence }
} finally {
  try { Complete-Pending } catch { Write-Note ('clics en attente : ' + $_.Exception.Message) }
}
$result = [ordered]@{ ok = $ok; action = $Action; step = $script:Step; message = $message; log = @($script:Log); files = @($script:Files) }
[System.IO.File]::WriteAllText($ResultFile, ($result | ConvertTo-Json -Compress -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
if (-not $ok) { exit 1 }
exit 0
