# FILES-IOS-01 — Plugin Fichiers : enregistrer et partager un fichier sur iPhone (P-07 et H-03 sur iPhone)

Module : M12 Personnalisation (transverse M11) · Ordre de construction : 5 (lot F, phase 3, **premier** du lot après l'avenant d'ADR) · Agents : **ios-mobile** (plugin Swift, Rust, capability, CI) et **settings-personalization** (`FileService.save` sur iPhone, P-07) · Relectures : qa-test, code-reviewer, **security-privacy (obligatoire : écriture d'un fichier choisi par l'utilisateur, fichier temporaire)** · Statut : à faire (fiche prête, 2026-10-08)
Story technique ajoutée au backlog par le product-owner (écart à signaler à Ali : une ligne de plus, aucune fonction nouvelle du PRD). Elle livre ce que l'ADR 0009 appelle « le plugin Fichiers de l'ordre 5 » et solde la dette d'ordre 5 « P-07 sur iPhone : modèle et rapport masqués ». Effet de bord voulu par H-03 critère 10 : le bouton « Exporter » du Rapport apparaît sur iPhone (voir critère 8).
Dépend de : H-03 (contrat `FileExporter`, boîte d'export), P-07 (modèle, rapport, `pickText`), I-01 (CI), I-03 (excursions).

> **Décision d'Ali du 2026-10-08** (`docs/decisions.md`, avenant lot F de l'ADR 0009) : le plugin présente le sélecteur « Enregistrer dans Fichiers » (`UIDocumentPickerViewController(forExporting:asCopy: true)`), **pas** le panneau de partage : H-03 exige qu'aucune donnée ne quitte l'appareil et exclut l'envoi par e-mail. Partout où cette fiche écrit « panneau de partage » ou « feuille de partage », lire « sélecteur Enregistrer dans Fichiers » ; « envoyer par Mail et par AirDrop » (A4) devient « aucune option Mail, Messages ni AirDrop ». Excursion du verrou : `file-picker`. Crate : `tauri-plugin-ct-files` (critère 10).

## Rappel

ADR 0009 : « Sur iPhone, l'export reste masqué jusqu'à l'ordre 5 : le plugin Fichiers (Swift, `UIDocumentPickerViewController`) implémentera le même contrat `FileService` dans `src/platform/files`, sans changer les features. Les crates dialog / fs ne seront pas activées sur iOS sans nouvel avenant. » H-03 critère 7 : l'app n'accède qu'au fichier choisi. P-07 critère 6 : le rapport des lignes rejetées est « proposé à l'enregistrement » ; critère 1 : « Télécharger un modèle ».

## À lire avant le code

`docs/adr/0009-statistiques-export-fichiers.md` (tout, dont l'avenant P-04 sur iPhone et l'avenant P-07), `docs/adr/0011-synchronisation-icloud.md` §22 points 1 et 2 (plugin appelé par Rust seul, aucun texte français en Swift), `docs/adr/0013-iphone-gestes-verrouillage-expiration.md` (excursions, avenant point 3), `docs/stories/{H-03,P-07}.md`, `src/platform/files/*`, `src-tauri/src/export.rs`, `src-tauri/capabilities/export.json`, `src-tauri/plugins/folder-bookmark`, `src/features/stats/ExportDialog.tsx`, `src/features/settings/importStore.ts` et l'écran d'import, `scripts/ios/plist-contract.json`.

## ADR requis avant le code

**Avenant à l'ADR 0009, section « Plugin Fichiers sur iPhone », par l'architecte, avant la première ligne** (le même avenant porte la partie P-04-iOS, voir cette fiche). Contenu attendu :
1. **Contrat Swift** (plugin local `files`, appelé par Rust seul, aucune permission pour la WebView) : une commande `present({ name, mime })` qui présente un `UIActivityViewController` (partage, « Enregistrer dans Fichiers », AirDrop, Mail) sur le fichier temporaire désigné par Rust, résultat `{ completed }` ; le choix du **panneau de partage** plutôt que du seul `UIDocumentPickerViewController` couvre aussi « export texte partageable » d'I-04 ; codes `not-foreground`, `failed` ; aucun texte français en Swift ; fixture de contrat `tests/fixtures/files/files-contract.json` contrôlée contre le Swift et Rust.
2. **Rust** : `export_save_file` existe sur iOS avec les mêmes contrôles qu'au PC (corps ≤ 64 Mio, nom réduit à un nom simple de 200 caractères, noms réservés), mais écrit un temporaire dans un sous-dossier dédié du cache de l'app (`exports/`, création exclusive, `sync_all`), appelle le plugin, **supprime toujours le temporaire** (succès, annulation, échec) et purge au démarrage les temporaires restants ; les contrôles de nom et de taille deviennent un module commun aux deux plateformes ; `reveal_exported_file` n'existe pas sur iOS ; capability `export-ios.json` (`platforms: ["iOS"]`, `allow-export-save-file` seulement).
3. **TypeScript, sécurité, CI** : `openFileService('tauri','ios')` rend un `FileService` réel (`canSave()` vrai, `save` via la commande, `pickText` inchangé par `<input type="file">`) ; excursion du verrou autour de `save` ; aucune clé Info.plist ; crate sous `cfg(target_os = "ios")` ; l'écart « dialog / fs non activées sur iOS » reste vrai.

## Critères testables sans Mac

Légende : **[R]** cargo test, **[U]** Vitest, **[S]** contrôle statique, **[E]** Playwright projet `iphone`, **[CI]** `build-ios.yml`.

1. **[U]** **Étant donné** (`tauri`, `ios`), **alors** `files.canSave()` est vrai, `files.reveal` est absent, `pickText` est celui du sélecteur du système (P-07 critère 13, tests inchangés) ; (`tauri`, `windows`) et le web inchangés (tests de `files.test.ts` non modifiés).
2. **[U]** **Quand** j'appelle `save` avec un faux transport qui répond `completed: true`, **alors** `{ saved: true }` sans `path` ; `completed: false` → `{ saved: false }` (annulation, ce n'est pas une erreur) ; rejet `not-foreground` → `FileExportError('unavailable')` ; autre rejet → `FileExportError('write-failed')` ; la promesse ne reste jamais en suspens (test de délai : la feuille fermée par iOS sans réponse est ramenée à une annulation au retour au premier plan).
3. **[R]** **Étant donné** un corps de 64 Mio + 1 octet, un nom vide, un nom à séparateurs (`..\x`, `/etc/x`), un nom réservé, **alors** Rust refuse ou réduit comme sur PC (mêmes tests, module commun) ; le temporaire est créé sous `exports/` seulement, en création exclusive ; il est **supprimé** après succès, annulation et échec simulés du plugin (faux transport) ; au démarrage les temporaires restants sont supprimés ; un lien symbolique à la place du dossier `exports/` est refusé (`unsafe-folder`) sans écriture.
4. **[S]** **Alors** un test lit le Swift et le Rust : commande et champs conformes à la fixture, codes de rejet Swift connus de Rust, aucune chaîne française en Swift, aucune permission `files:` dans les capabilities (Rust seul appelle), `export-ios.json` ne contient que `allow-export-save-file`, `export.json` (PC) inchangé, crate déclaré sous `cfg(target_os = "ios")` seulement, ni `tauri-plugin-dialog` ni `tauri-plugin-fs` dans `cargo tree --target aarch64-apple-ios`.
5. **[U]** **P-07 sur iPhone** : **alors** l'écran d'import affiche « Télécharger un modèle » et, après un aperçu avec rejets, « Télécharger le rapport des lignes rejetées » (aujourd'hui masqués sur iPhone) ; le contenu du modèle et du rapport est **identique** à celui du PC (mêmes octets, mêmes noms par `importFileName`) ; un faux `save` en échec affiche « L'enregistrement n'a pas abouti » avec le code, l'import en cours n'est pas perdu.
6. **[U]** **Alors** P-07 critères 6 et 9 sur iPhone : le rapport rechargé par `pickText` se réimporte sans erreur (colonnes supplémentaires ignorées) ; apostrophe de neutralisation retirée.
7. **[E]** Projet `iphone`, faux `FileService` (`globalThis.__ctFiles`) : import d'un CSV avec 3 rejets, « Télécharger un modèle » et rapport enregistrés (contenus lus), annulation de la feuille sans message d'erreur ; projet `pc` inchangé (boîtes Rust simulées).
8. **[U]** **Effet de bord H-03** : **alors** sur iPhone le bouton « Exporter » de Rapport apparaît (`canSave()`), ouvre la feuille d'export (H-03 critère 10, test mis à jour : « iPhone : bouton visible, enregistrement par le panneau de partage ») ; CSV, JSON, PDF et image s'enregistrent par `save` avec les noms de `historyExport` ; le fichier d'un export à plus de 64 Mio est refusé avec le message « Fichier trop volumineux » (code `too-large`).
9. **[U]** **Aucun échec silencieux.** **Alors** tout rejet de `save` (modèle, rapport, export H-03, logs d'I-04) affiche un message persistant près du bouton avec le code et « Réessayer », et inscrit l'entrée au journal (I-04) ; jamais un bouton sans effet.
10. **[CI]** `build-ios.yml` vert sur la branche du lot ; `cargo tree --target aarch64-apple-ios -i tauri-plugin-files` (nom exact fixé par l'ADR) réussit, la même commande pour `x86_64-pc-windows-msvc` ne trouve rien ; contrat Info.plist **sans nouvelle entrée** ; le résumé du run signale l'absence éventuelle de la clé.

## Critères seulement vérifiables sur l'appareil (reportés dans `_checklist-ordre-5.md`)

- A1. Import : « Télécharger un modèle » ouvre la feuille de partage ; « Enregistrer dans Fichiers » (dossier « Sur mon iPhone ») ; ouvrir le fichier dans Fichiers puis dans Numbers ou Excel : colonnes et accents corrects (séparateur « ; », BOM).
- A2. Importer un CSV choisi dans Fichiers (iCloud Drive et « Sur mon iPhone »), refus lisible d'un fichier de plus de 2 Mo ; rapport des rejets enregistré puis rouvert.
- A3. Export H-03 : PDF et image du Rapport enregistrés, ouverts dans Fichiers, lisibles ; **mémoire du canvas** de WKWebView sur un mois chargé (aucun plantage, noter la durée).
- A4. Fermer la feuille sans choisir (balayage vers le bas) : aucun message d'erreur, aucun fichier ; envoyer par Mail et par AirDrop : le fichier arrive.
- A5. Aucun fichier temporaire dans le conteneur après usage (vérifier par l'export de logs d'I-04 : entrée de purge au démarrage, ou inspection du conteneur si possible).
- A6. Verrou Face ID actif : partager vers Mail et revenir au bout de plus de 30 s : l'app est reverrouillée (règle de l'avenant 0013 point 3), aucune perte d'état de l'import.

## Hors de cette story

Export de la base ou des sauvegardes hors de l'appareil (hors de P-04, fichiers non chiffrés), choix d'un dossier d'export mémorisé, ouverture d'autres formats (ICS, JSON, Excel), sélecteur de fichiers natif pour l'import (le `<input type="file">` reste), glisser-déposer.

## Ordre des sous-tâches

1. architect : avenant ADR 0009 (avant le code ; il porte aussi P-04-iOS).
2. ios-mobile : crate `src-tauri/plugins/files` (Swift, `build.rs`), fixture de contrat, module commun de nom et de taille, `export_save_file` iOS, capability `export-ios.json`, tests `cargo test`.
3. settings-personalization : `createTauriFiles` pour iOS (`openFileService`), excursion, messages d'échec ; P-07 (boutons visibles, tests) ; H-03 (critère 10 mis à jour).
4. e2e `iphone` et `pc` ; `build-ios.yml` sur la branche ; qa-test, code-reviewer, security-privacy ; checklist d'appareil.
