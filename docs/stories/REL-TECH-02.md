# REL-TECH-02 — La désinstallation ne supprime jamais les données de l'application

Module : Livraison unique · Ordre de construction : transverse (avant REL-03) · Agent : **ci-release** (crochet, build NSIS en CI, smoke étendu) + **qa-test** · Statut : **fait** (QA, relecture approuvée en trois passes, PR #41 fusionnée le 2026-10-17, run 39034221587 vert) 
Story technique, sans équivalent au PRD (écart à noter dans docs/decisions.md). Constat B15 de l'audit, décision 9 d'Ali du 2026-10-17 : crochet NSIS, pas de modèle personnalisé ; « une case visible mais inerte me suffit ».
Dépend de : REL-TECH-01 (job `smoke-windows`, `playwright.smoke.config.ts`, `tests/smoke/window-capture.ps1`, ADR 0016). Ne touche ni `src/domain` ni `src/db`.
Estimation de l'audit : crochet 1 h, garde-fou 1 h, smoke étendu 4 h, documentation 1 h.

## Contexte

- Le 2026-10-17, installation manuelle de la 0.3.3 sur le PC d'Ali par-dessus la 0.1.1, choix « Désinstaller avant d'installer ». Sur la page de confirmation du désinstalleur, la case « Supprimer les données de l'application » était cochée : `%APPDATA%\fr.circletasks.planner` et `%LOCALAPPDATA%\fr.circletasks.planner` ont été supprimés à 10:54:35 (journal NTFS). La base a été recréée vide et les données reprises depuis iCloud comme sur un nouvel appareil ; les sauvegardes locales et le journal technique sont perdus.
- Modèle NSIS de Tauri 2.12.1 (`crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi`) : la case est créée dans `un.ConfirmShow`, son état est lu dans `un.ConfirmLeave` vers la variable globale `$DeleteAppDataCheckboxState`. Dans `Section Uninstall`, la macro `NSIS_HOOK_PREUNINSTALL` (fournie par `bundle.windows.nsis.installerHooks`, un fichier `.nsh`) est insérée en tête de section, AVANT le bloc `${If} $DeleteAppDataCheckboxState = 1` / `${AndIf} $UpdateMode <> 1` qui exécute `RmDir /r "$APPDATA\${BUNDLEID}"` et `RmDir /r "$LOCALAPPDATA\${BUNDLEID}"`.
- La mise à jour intégrée (plugin updater, arguments `/P /UPDATE`) ne lance jamais le désinstalleur : seule l'installation manuelle par-dessus une version existante et la désinstallation depuis Windows sont concernées.
- Pourquoi aucun test ne l'a vu : aucun test n'exécute l'installeur ni le désinstalleur réels ; le test de fumée (REL-TECH-01) lance le binaire extrait (`--no-bundle`), et le banc de l'ADR 0006 n'exécute pas l'installeur NSIS.
- Écarts de documentation constatés à la rédaction (branche `rel-tech-02`, depuis `origin/main`) : `docs/audit-1.0.md` ne contient ni la ligne B15 ni la décision 9 (le tableau s'arrête à B14, la section 5 à 7 points, la section 6 à 8 décisions) ; `docs/install-pc.md` n'existe pas (seul `docs/install-iphone.md` existe). Voir critère 13.

## Décisions retenues

- Crochet `NSIS_HOOK_PREUNINSTALL` qui force l'état de la case à 0. Pas de modèle NSIS personnalisé (maintenance du modèle à chaque version de Tauri). La case reste affichée, cochée ou non, et reste sans effet : choix d'Ali.
- Conséquence assumée : il n'existe plus de désinstallation « avec données » par l'installeur. Pour effacer les données, supprimer à la main les deux dossiers (documenté dans le guide).

## Critères testables

### Crochet

1. **Étant donné** le fichier `src-tauri/windows/hooks.nsh`, **quand** on le lit, **alors** il définit `!macro NSIS_HOOK_PREUNINSTALL` qui exécute `StrCpy $DeleteAppDataCheckboxState 0`, avec un commentaire qui donne : le pourquoi (incident du 2026-10-17, constat B15), la référence de la décision 9, et le fait que l'état de la case est ignoré volontairement. Les autres macros de crochet ne sont pas définies.
2. **Étant donné** `src-tauri/tauri.conf.json`, **alors** `bundle.windows.nsis.installerHooks` vaut `windows/hooks.nsh` (chemin relatif à `src-tauri`, à confirmer par l'agent) sans modifier `languages` ni `installMode` (`currentUser`).
3. **Étant donné** que `--config src-tauri/tauri.smoke.conf.json` est fusionné par-dessus `tauri.conf.json` (fusion d'objets, sans redéclaration nécessaire), **alors** la configuration de fumée hérite du crochet sans le redéclarer ; l'agent le confirme par le script NSIS généré de la fumée (critère 4), pas par hypothèse. Si la fusion ne le fait pas, le crochet est redéclaré dans la configuration de fumée et la raison est notée dans la fiche.

### Garde-fou statique (CI)

4. **Étant donné** un `tauri build --debug --bundles nsis` (profil debug acceptable), **quand** le test Vitest Node (dossier `scripts/` ou `tests/smoke/`, chemin du script généré à confirmer par l'agent, attendu `src-tauri/target/<profil>/nsis/x64/installer.nsi`) lit le script généré, **alors** : (a) le contenu de la macro du crochet est présent dans `Section Uninstall`, (b) il précède la ligne `RmDir /r "$APPDATA\${BUNDLEID}"` (et celle de `$LOCALAPPDATA`), (c) le nom `$DeleteAppDataCheckboxState` existe encore dans le script (lecture par `un.ConfirmLeave` et test dans `Section Uninstall`).
5. **Quand** Tauri renomme la variable ou déplace le crochet après la suppression, **alors** le test échoue avec un message qui dit quelle propriété est perdue : jamais une protection perdue en silence. Preuve par Vitest sur deux scripts NSIS factices (variable renommée, crochet placé après `RmDir`), à côté du cas conforme.
6. **Étant donné** l'absence de NSIS en local, **alors** le test lit le script s'il existe et se déclare ignoré avec un message explicite hors CI ; en CI (variable `CI`) l'absence du fichier est un échec, jamais un test ignoré. Le job qui le lance construit l'installeur avant.

### Smoke Windows étendu

7. **Étant donné** la configuration de fumée, **alors** l'identifiant reste `fr.circletasks.planner.smoke` et un `productName` de fumée distinct de `CircleTasks` est ajouté : le dossier d'installation (`%LOCALAPPDATA%\<productName>`), les raccourcis et l'entrée de désinstallation ne touchent jamais `%LOCALAPPDATA%\CircleTasks` ni les données réelles d'un poste de développement. L'agent vérifie que la configuration de fumée ne demande pas de clé de signature de l'updater (pas d'artefact `.sig` pour la fumée) et que le build REL-TECH-01 `--no-bundle` reste intact.
8. **Étant donné** le job `smoke-windows` (`windows-latest`), **quand** il s'exécute, **alors** il construit l'installeur NSIS de fumée, puis, avec les mêmes garanties que REL-TECH-01 (1 worker, `retries: 0`, aucun délai allongé, aucun `webServer`) :
   - (a) installe en mode silencieux (`/S`) ;
   - (b) écrit une donnée témoin dans `%APPDATA%\fr.circletasks.planner.smoke` (fichier marqueur au contenu unique, ou lancement de l'app qui crée la base) ;
   - (c) relance le MÊME installeur en mode graphique et pilote l'interface par UI Automation PowerShell (même approche que `tests/smoke/window-capture.ps1`) : page « déjà installé » → « Désinstaller avant d'installer » → Suivant → fenêtre du désinstalleur : COCHER « Supprimer les données de l'application » (la case est trouvée et sa case cochée est vérifiée avant de continuer) → Désinstaller → fin d'installation.
9. **Alors**, après le pas (c), la donnée témoin existe toujours avec son contenu, et l'application réinstallée démarre (binaire installé lancé, fenêtre « CircleTasks » trouvée, processus arrêté en fin de test).
10. **Quand** le test lance ensuite `uninstall.exe` du dossier d'installation en mode graphique, coche la case et désinstalle, **alors** la donnée témoin existe toujours et le dossier d'installation a disparu. Le dossier de données de fumée est effacé seulement ensuite et seulement s'il porte l'identifiant `fr.circletasks.planner.smoke` (même garde que REL-TECH-01).
11. **Alors** tout échec est explicite : élément d'interface introuvable, case non cochée, page inattendue ou délai borné dépassé produisent un échec nommant l'étape, avec capture de la fenêtre jointe au rapport ; les processus d'installation, de désinstallation et de l'app de fumée sont tués en fin de test, y compris sur échec. Les artefacts (rapport, captures) sont conservés en cas d'échec (comme REL-TECH-01 critère 16). Le job reste requis par « suite verte ».
12. **Étant donné** que le test doit pouvoir échouer, **alors** la preuve de détection est faite une fois, sans être laissée dans le dépôt : sur une branche jetable ou localement, crochet retiré, le pas (c) fait échouer le job (données supprimées) ; le résultat est noté au journal.

### Documentation

13. **Alors** : `docs/install-pc.md` est créé s'il n'existe pas (installation, mise à jour, désinstallation) avec le paragraphe « depuis la version X.Y.Z, la case « Supprimer les données de l'application » est sans effet : les données sont conservées » et l'avertissement en gras « avant la version X.Y.Z, cocher cette case supprime vos données » conservé tant que des versions antérieures circulent ; la procédure manuelle pour effacer les données est donnée. `docs/release-pc.md` mentionne le crochet et le garde-fou (critère 4) dans « Points d'attention ». ADR 0006 : avenant court (crochet NSIS, mise à jour non concernée, désinstallation avec données impossible par choix). `CHANGELOG.md` : entrée sous la version qui porte le crochet (notes lues par l'app, ADR 0007 : texte en français, sans jargon). `docs/journal.md` : entrée du jour. `docs/audit-1.0.md` : ligne B15 et décision 9 ajoutées (le product-owner propose le texte, Ali valide) ; `docs/decisions.md` : écart sans équivalent au PRD. X.Y.Z est la version qui contient le crochet.

## Limites assumées

- Le crochet protège les versions qui le contiennent. Le désinstalleur d'une version antérieure (0.1.1 à 0.3.3) garde la case active : quand on installe la première version avec crochet par-dessus une ancienne en choisissant « Désinstaller avant d'installer », c'est le désinstalleur ANCIEN qui s'exécute et la case reste dangereuse. L'avertissement en gras du guide couvre ce cas ; le smoke ne peut pas le tester sans publier une version antérieure (non couvert).
- Une désinstallation Windows laisse désormais toujours les dossiers de données ; ce comportement est voulu.
- Le pilotage de l'interface (messages Win32) dépend des textes français du modèle NSIS de Tauri (`languages: French`) ; un changement de libellé par Tauri fait échouer le smoke avec le nom de l'étape (voulu, critère 11).
- CPU du runner : délais bornés mais généreux, jamais allongés pour masquer un échec.

## Hors de cette story

- Modèle NSIS personnalisé (décision 9 : non).
- Toute modification du plugin updater ou de la mise à jour intégrée.
- Désinstallation « avec données » (volontairement impossible désormais).
- iPhone (aucune commande iOS locale) ; signature de l'installeur ; publication (REL-03).
- Toute fonction de la liste « Hors périmètre » du PRD.

## Ordre des sous-tâches

1. Crochet `src-tauri/windows/hooks.nsh` + `installerHooks` (critères 1, 2).
2. Build NSIS debug local ou CI, lecture du script généré, confirmation de l'héritage par la configuration de fumée (critère 3).
3. Garde-fou Vitest Node + cas factices (critères 4, 5, 6) ; étape de build NSIS dans la CI avant ce test.
4. `productName` de fumée et build NSIS de fumée (critère 7).
5. Smoke étendu : installation silencieuse, donnée témoin, pilotage graphique, vérifications (critères 8 à 11), puis preuve de détection (critère 12).
6. Documentation (critère 13).
7. qa-test, puis code-reviewer.

## Vérifications

- Local : test Vitest du garde-fou (cas factices) ; lint et typage verts. Le smoke complet ne tourne qu'en CI (installeur graphique), ou en local sur une session Windows interactive.
- CI : jobs `smoke-windows` et garde-fou verts sur la branche, statut « suite verte ».
- Preuve de détection : critères 5 et 12.
- Revue : code-reviewer approuve ; aucun fichier écrit hors du dépôt ; aucun secret ; aucun test désactivé ni délai allongé.
- Clôture refusée si un critère manque : le product-owner vérifie les 13 critères avant « fait ».

## Vérification (branche rel-tech-02, 2026-10-17)

| Critère | Résultat |
| --- | --- |
| 1 | `src-tauri/windows/hooks.nsh` : seule `NSIS_HOOK_PREUNINSTALL`, `StrCpy $DeleteAppDataCheckboxState 0`, commentaire (incident, B15, décision 9, case ignorée volontairement, modèle amont et tag `tauri-cli-v2.12.1`). |
| 2 | `installerHooks: "./windows/hooks.nsh"` (convention de la doc Tauri 2 ; chemin relatif à `src-tauri`, résolu en absolu par le bundler : `!include "D:\a\circletasks\circletasks\src-tauri\windows\hooks.nsh"`). `languages` et `installMode` inchangés. |
| 3 | Héritage constaté sur le script généré par la configuration de fumée : l'`!include` est présent sans redéclaration. |
| 4 | `tests/nsis/installerScript.test.ts` (`npm run test:nsis`) lit `src-tauri/target/smoke/debug/nsis/x64/installer.nsi`. Écart de forme : le script généré ne contient pas le corps de la macro mais `!insertmacro NSIS_HOOK_PREUNINSTALL` (sous `!ifmacrodef`) et l'`!include` de `hooks.nsh` ; le contrôle porte donc sur l'insertion avant les deux `RmDir /r`, sur le corps de la macro dans le fichier inclus, sur l'existence de `$DeleteAppDataCheckboxState` (Var, `un.ConfirmLeave`, test) et sur l'absence de réaffectation. |
| 5 | `tests/unit/smoke/nsisScript.test.ts` : conforme, CRLF, variable renommée, crochet après `RmDir`, crochet absent, include absent, variable réaffectée, fichier de crochets dégradé, commentaire. Chaque message nomme la propriété perdue. |
| 6 | Hors CI : test ignoré avec message ; en CI : échec si le script est absent (vérifié en local avec `CI=true`). Le job construit l'installeur avant. |
| 7 | `productName: "CircleTasks Smoke"` dans `tauri.smoke.conf.json` ; aucun `createUpdaterArtifacts`, aucun `.sig` ; build `--no-bundle` et `pc-demarrage.spec.ts` inchangés et verts (nom de binaire `circletasks`, titre « CircleTasks »). |
| 8 à 11 | `tests/smoke/pc-installeur.spec.ts` et `tests/smoke/installer-drive.ps1` : installation `/S`, donnée témoin, réinstallation graphique (case cochée et vérifiée), application installée démarrée (CDP + fenêtre Win32), `uninstall.exe` graphique, dossier d'installation supprimé, nettoyage gardé par `.smoke`. Échec : étape nommée, capture d'écran, capture de fenêtre, contrôles Win32 et arbre UI Automation, processus tués, artefact `smoke-windows`. |
| 12 | Preuve : crochet vidé au commit 20500f7a, run 39029716402 rouge sur le garde-fou ET sur le smoke (« donnée témoin supprimée par la désinstallation »), crochet remis au commit f8343a1a. Le smoke s'exécute désormais même si le garde-fou échoue (`if: !cancelled()`). |
| 13 | `docs/install-pc.md` (paragraphe, avertissement en gras, procédure d'effacement), `docs/release-pc.md`, ADR 0006 et 0016 (avenants), CHANGELOG « Non publié », journal, backlog, audit-1.0 et dettes (en cours). Le numéro X.Y.Z sera fixé à la publication. |

Run vert : 39030179275 (tous les jobs, dont `cargo audit` et `Vitest dom` depuis la fusion de la PR #40). Runs intermédiaires : 39024162153 (UI Automation : volets sans patterns), 39024832537 (page finale « Fermer »), 39027366664 et 39027981603 (BM_CLICK sans effet sur « Fermer »), 39028571800 (WM_COMMAND, copie temporaire `Un.exe`).

### Causes trouvées pendant la mise au point

- UI Automation expose les contrôles NSIS en simples volets sans `InvokePattern` ni `TogglePattern` : lecture et actions par l'API Win32 (`EnumChildWindows`, `WM_GETTEXT`, `BM_GETCHECK`) ; UI Automation ne sert plus qu'au rapport d'échec.
- `MUI_FINISHPAGE_NOAUTOCLOSE` : la page finale porte « Fermer » et non « Terminer ».
- `BM_CLICK` reste sans effet sur « Fermer » alors que l'installeur répond ; `WM_COMMAND(BN_CLICKED)` envoyé au dialogue principal (ce que fait un bouton) fonctionne et sert pour tous les boutons poussoirs.
- Lancé sans `_?=`, `uninstall.exe` se copie en `%TEMP%\~nsu*.tmp\Un.exe` (et non `Au_.exe`).
- La page « Désinstaller avant d'installer » n'apparaît que si la version installée est plus ancienne : le pilote réécrit `DisplayVersion` du produit de fumée à `0.0.1` (HKCU) avant de relancer l'installeur.

### Limites

- Le crochet protège les versions qui le contiennent : l'ancien désinstalleur (0.1.1 à 0.3.3) garde sa case active au premier passage ; non testable sans publier une version antérieure.
- La clé `HKCU\Software\<éditeur>\CircleTasks` n'est plus supprimée à la désinstallation (le modèle ne la supprime que dans le bloc de la case) ; sans conséquence pour les données.
- Le pilotage dépend des libellés français du modèle NSIS ; à relire à chaque montée du CLI Tauri.

### Essai jetable de l'échéance du pilote (revue du 2026-10-17)

Échéance du pilote réduite à 5 s (commit af1704b9, run 39033655114, rouge) : le pilote a écrit son résultat (`echeance globale du pilote … depassee : arret de l installeur apres « Fermer »`, étape nommée), 7 pièces jointes (captures de chaque page, capture d'écran et arbre des contrôles) AVANT que `spawnSync` n'arrive à sa borne de 300 s. Essai annulé par un commit inverse (jamais de force) ; run vert avant l'essai : 39032887354 (commit 81a31e6b).
