; REL-TECH-02 : crochets NSIS de l'installeur et du désinstalleur Windows de CircleTasks.
; Fichier déclaré par `bundle.windows.nsis.installerHooks` (src-tauri/tauri.conf.json), inclus par le modèle NSIS de Tauri.
;
; Pourquoi : le 2026-10-17, une installation manuelle de la 0.3.3 par-dessus la 0.1.1 (choix « Désinstaller avant d'installer »)
; a lancé l'ancien désinstalleur. Sa page de confirmation propose la case « Supprimer les données de l'application » ; cochée, elle a effacé
; %APPDATA%\fr.circletasks.planner et %LOCALAPPDATA%\fr.circletasks.planner (base, sauvegardes locales, journal technique).
; Constat B15 de l'audit 1.0 (docs/audit-1.0.md), décision 9 d'Ali du 2026-10-17 : un crochet, pas de modèle NSIS personnalisé.
;
; Ce que fait le crochet : NSIS_HOOK_PREUNINSTALL est insérée en tête de `Section Uninstall`, avant le bloc qui exécute
; `RmDir /r "$APPDATA\${BUNDLEID}"` et `RmDir /r "$LOCALAPPDATA\${BUNDLEID}"` si `$DeleteAppDataCheckboxState = 1`. Elle remet cet état à 0 :
; la suppression des données n'a donc jamais lieu. La case reste affichée, cochée ou non, et ne fait rien : l'état de la case est IGNORÉ
; VOLONTAIREMENT (choix d'Ali : « une case visible mais inerte me suffit »). Pour effacer les données, supprimer à la main les deux dossiers
; (docs/install-pc.md).
; La mise à jour intégrée (plugin updater, arguments /P /UPDATE) ne lance jamais le désinstalleur : elle n'est pas concernée.
;
; Modèle amont : crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi, tag tauri-cli-v2.12.1 (`Var DeleteAppDataCheckboxState`, `un.ConfirmLeave`,
; `Section Uninstall`). Si Tauri renomme la variable ou déplace le crochet, le garde-fou tests/nsis/installerScript.test.ts (job smoke-windows) échoue,
; et le smoke tests/smoke/pc-installeur.spec.ts le constate sur de vraies données. Aucune autre macro de crochet n'est définie ici.

!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $DeleteAppDataCheckboxState 0
!macroend
