# ADR 0006 — App PC : zone de notification, démarrage avec Windows, mise à jour

- Statut : accepté
- Date : 2026-10-02
- Tâches : D-01, D-02, D-03 (ordre 1, agent desktop-tauri)

## Contexte

L'app PC (Tauri 2, Windows 10/11) doit rester active en zone de notification (capture rapide et synchro à venir), démarrer avec Windows, et se mettre à jour seule depuis le dépôt public `circletasks-releases`. Le front doit continuer à tourner dans le navigateur (`npm run dev`, Playwright) et l'iPhone partage le même code : tout ce qui est spécifique au PC est isolé, côté Rust dans `src-tauri/src/desktop.rs` (compilé sous `cfg(desktop)`), côté TypeScript dans `src/platform/desktop`.

## Décision

### Architecture

- `src-tauri/src/desktop.rs` : plugins PC, icône de zone de notification, fermeture = masquage, instance unique, démarrage réduit. Le build iOS ne compile ni ces plugins (dépendances `cfg(not(any(android, ios)))`) ni ce module.
- `src/platform/desktop` : contrat `DesktopPlatform` (`types.ts`), implémentation Tauri (`tauriDesktop.ts`, seul fichier qui importe les plugins), constantes partagées (`releases.ts`). `openDesktopPlatform()` renvoie `null` hors Windows installé ; le résultat est `AppContainer.desktop` (`null` en navigateur, sur iPhone et par défaut en test). Les features ne voient jamais Tauri.
- Aucune notification Windows n'est émise par ces fonctions : le PC n'envoie aucun rappel (CLAUDE.md).

### D-01 — Zone de notification

- Icône : icône de l'app, info-bulle « CircleTasks » (nom du produit, non traduit). Clic gauche = fenêtre au premier plan ; clic droit = menu.
- Menu, dans l'ordre : « Ouvrir CircleTasks », « Ajout rapide », « Synchroniser » (grisé : M15 n'existe pas, Y-03), séparateur, « Quitter ».
- **Textes** : source unique `src/i18n` (`desktop.tray.*`). Le front les envoie à la commande `set_tray_labels` au démarrage (`features/app/desktop.ts`). **Exception documentée** : Rust garde des libellés de repli (`fallback_labels`) pour la courte période entre la création de l'icône et la réception des textes, ou si l'interface ne démarre pas (« Quitter » doit rester accessible). Un test Vitest (`consistency.test.ts`) vérifie qu'ils sont égaux à `fr.ts`.
- Fermer la fenêtre principale (croix, Alt+F4) la masque (`CloseRequested` interceptée). Le réglage `desktop.closeToTray` du modèle n'est pas exposé : le PRD ne demande pas de désactivation (fiche D-01).
- Fenêtre `main` créée **masquée** par `src-tauri/tauri.windows.conf.json` (fusionné par Tauri pour Windows seulement : le tableau des fenêtres y est répété en entier, la base `tauri.conf.json` garde la fenêtre visible pour iOS), puis affichée par `setup` sauf démarrage réduit : aucun flash lors d'un démarrage avec Windows.
- Instance unique (`tauri-plugin-single-instance`, premier plugin) : un second lancement affiche la fenêtre existante, sauf s'il porte `--minimized`.
- « Ajout rapide » : affiche la fenêtre et émet l'événement `desktop://quick-add` ; le front (`quickAdd.ts`) va sur Aujourd'hui et focalise « Nouvelle tâche » comme Ctrl+N. Remplacé par la mini-fenêtre à Q-01.
- « Quitter » : Rust émet `desktop://quitting`, le front termine ses écritures en cours (une lecture passe après les écritures en file du pilote SQL) puis appelle `confirm_quit` ; attente bornée à 2 s (`QUIT_GRACE`), puis `app.exit(0)` et fermeture des connexions par tauri-plugin-sql (`RunEvent::Exit`).

### D-02 — Démarrage avec Windows

- `tauri-plugin-autostart` (entrée du registre de l'utilisateur courant, sans droits administrateur), argument `--minimized`. Le lancement lit cet argument et ne montre pas la fenêtre.
- Réglages (PC seulement) : section « GÉNÉRAL », interrupteur « Démarrer avec Windows », désactivé par défaut. L'état affiché est celui de l'entrée système (`isEnabled`), relu à chaque ouverture ; le réglage local `desktop.launchAtStartup` n'en est que le miroir et est réaligné.

### D-03 — Mise à jour

- `tauri-plugin-updater` + `tauri-plugin-process` (redémarrage) ; endpoint : `https://github.com/doncivo/circletasks-releases/releases/latest/download/latest.json` (`plugins.updater.endpoints`, aucun secret). Le propriétaire GitHub `doncivo` est celui de l'identité git du dépôt : à confirmer à la création du dépôt public (PREP-01) ; il est répété dans `releases.ts` et le périmètre de l'opener, et `consistency.test.ts` et `cargo test` vérifient la cohérence des trois endroits.
- **Clé publique** : posée dans `plugins.updater.pubkey` de `src-tauri/tauri.conf.json` (clé publique réelle fournie par Ali, plus de placeholder ; le test cargo `d03_10_real_public_key_is_in_place_and_well_formed` exige un fichier .pub minisign valide). La clé privée et son mot de passe ne sont nulle part dans le dépôt : secrets GitHub `TAURI_SIGNING_PRIVATE_KEY` et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` pour `build-windows.yml` (ci-release).
- `requireSignedVersion: true` : le commentaire signé de chaque paquet porte sa version et doit égaler la version annoncée par `latest.json` (anti-rétrogradation : le fichier JSON n'est pas signé, le paquet l'est). `allowDowngrades` et le transport non sécurisé restent faux. Mode d'installation Windows `passive` (progression visible, redémarrage automatique).
- `bundle.createUpdaterArtifacts` n'est **pas** activé dans `tauri.conf.json` : il exigerait la clé privée pour tout `tauri build` local. Le workflow de release l'active par `--config '{"bundle":{"createUpdaterArtifacts":true}}'` avec le secret.
- Planification (`features/updater/updateChecks.ts`) : vérification 5 s après le lancement, puis toutes les 24 h comparées à l'horloge injectée (`container.clock`) par une minuterie de 60 s (robuste à la veille) ; après un échec, nouvelle tentative au bout de 1 h. `desktop.updater.lastCheckAt` est écrit à chaque vérification réussie.
- Proposition : bandeau discret (`UpdateBanner`) avec « Voir les notes », « Installer et redémarrer », « Plus tard » ; **pas** d'« Ignorer cette version » (QB-16, PC et iPhone partagent la version de schéma). « Plus tard » ferme le bandeau ; la même version est reproposée à la vérification suivante. `skippedVersion` est retiré du réglage `desktop.updater`.
- Installation : téléchargement avec progression, signature vérifiée par le plugin, installation, `relaunch`. Signature refusée : « Mise à jour refusée : signature invalide », l'app actuelle continue. Réseau absent : aucune erreur bloquante, journalisée (`logDesktopFailure`), « À propos » affiche « Impossible de vérifier les mises à jour ».
- « À propos » (Réglages, PC seulement) : version installée, « Rechercher une mise à jour », lien « Dernière version » (page `…/releases/latest`, ouverte par `tauri-plugin-opener` avec un périmètre limité à ce dépôt).
- Non couvert ici (autres agents) : sauvegarde de la base avant migration (data-model, critères 8 et 9), workflow `build-windows.yml` et génération de `latest.json` (ci-release), critères 10 et 11 (PREP-01).

### Commandes Rust

| Commande | Entrée | Sortie | Erreurs `{ code, message }` |
| --- | --- | --- | --- |
| `set_tray_labels` | `labels: { open, quickAdd, sync, quit, syncEnabled }` | `void` | `tray-unavailable`, `menu` |
| `confirm_quit` | aucune | `void` | aucune |

Déclarée dans `build.rs` (manifeste d'application) : sa permission `allow-set-tray-labels` est la seule qui l'ouvre. Les plugins n'exposent que ce que le front utilise.

### Permissions (capabilities)

- `default.json` (fenêtre `main`, Windows et iOS) : inchangée (`core:default`, SQL).
- `desktop.json` (fenêtre `main`, **Windows seulement**) : `allow-set-tray-labels`, `autostart:allow-enable|disable|is-enabled`, `updater:allow-check`, `updater:allow-download-and-install`, `process:allow-restart`, `opener:allow-open-url` limité à `https://github.com/doncivo/circletasks-releases/releases/*`. Aucune permission `:default` de plugin, aucun joker (vérifié par `cargo test`).
- CSP inchangée : les requêtes de mise à jour partent du Rust, pas de la WebView.

### Dépendances ajoutées

| Paquet | Rôle | Licence | Plateforme |
| --- | --- | --- | --- |
| crates `tauri-plugin-single-instance`, `-autostart`, `-updater` (rustls), `-process`, `-opener` ; feature `tray-icon` de `tauri` | Instance unique, démarrage, mise à jour, redémarrage, ouverture du lien | MIT / Apache-2.0 | PC seulement (absentes du build iOS) |
| `@tauri-apps/plugin-autostart`, `-updater`, `-process`, `-opener` | Ponts JS, importés dans `src/platform/desktop/tauriDesktop.ts` uniquement, chargés dynamiquement | MIT / Apache-2.0 | PC (jamais importés hors Tauri Windows) |
| dev : `minisign`, `base64`, `tokio`, feature `test` de `tauri` | Banc de test de la mise à jour (clé jetable en mémoire) | MIT / Apache-2.0 | tests |

## Taille de l'installeur

Mesure du 2026-10-02 (`npm run tauri build`, NSIS, avec updater, process, autostart, single-instance et opener) : `CircleTasks_0.1.0_x64-setup.exe` = **2,70 Mo**, sous le budget de 15 Mo (PRD 8). `tauri-plugin-opener` est conservé.

## Tests

- Vitest : `src/platform/desktop/*.test.ts` (plugins simulés, cohérence TS / Rust / configuration), `src/features/updater/*.test.ts(x)` (états, bandeau, planification 24 h avec horloge injectée), `src/features/app/desktop.test.tsx`, `src/features/settings/SettingsScreen.desktop.test.tsx`, `src/features/today/TodayQuickAdd.test.tsx`.
- `cargo test` (`src-tauri/tests/desktop`) : logique du menu et du démarrage réduit, garde-fous de configuration, banc de mise à jour : clé minisign jetable générée **en mémoire**, serveur HTTP local, vrai plugin `tauri-plugin-updater` (détection, version égale ou inférieure, téléchargement signé, autre clé, paquet modifié, rétrogradation, signature sans version, placeholder, réseau absent). Le lancement de l'installeur NSIS n'est pas exécuté en test.
- Les tests Rust sont des tests d'intégration (`tests/`) et non des tests unitaires : sous Windows, un exécutable de test lié à tauri ne démarre pas sans manifeste comctl32 v6 (`STATUS_ENTRYPOINT_NOT_FOUND`). `build.rs` l'embarque pour les cibles `tests` (`windows-test.manifest`) et les tests unitaires de la lib sont désactivés (`test = false`).

## Conséquences

- Ajouter un élément au menu : `TrayAction`, `menu_layout`, `desktop.tray.*` (fr et en), `TrayLabels` (TS), et le test d'ordre.
- Ajouter une commande Rust : `build.rs` (liste), `desktop.json` (permission), cette table.
- La clé publique réelle se pose dans `tauri.conf.json` (une seule ligne) ; aucun autre changement de code.
- Q-01 (capture rapide) remplacera la cible de « Ajout rapide » et enregistrera Ctrl+Alt+Espace via `tauri-plugin-global-shortcut` ; D-04 ajoutera les autres fenêtres.

## Avenant D-04 : raccourci global

- `tauri-plugin-global-shortcut` (Rust seul : aucune permission de plugin dans les capabilities, le front passe par trois commandes applicatives). `src-tauri/src/shortcut.rs` : `parse_chord` (validation pure, testée), `set_quick_capture_shortcut`, `clear_quick_capture_shortcut`, `get_quick_capture_shortcut`. Erreurs `{ code, message }` : `shortcut-syntax`, `shortcut-no-modifier`, `shortcut-windows-key`, `shortcut-reserved`, `shortcut-in-use`, `shortcut-unavailable`.
- Notation unique de la combinaison (registre `SHORTCUTS`, réglage local `shortcut.quickCapture` `{ enabled, keys }`, Rust) : `Ctrl+Alt+Space`. Remplacement atomique : la nouvelle combinaison est enregistrée avant de libérer l’ancienne.
- Port TypeScript `GlobalShortcuts` (`register`, `unregister`, `isRegistered`) dans `DesktopPlatform.globalShortcuts`, avec faux pour les tests. Capabilities `desktop.json` : `allow-set-quick-capture-shortcut`, `allow-clear-quick-capture-shortcut`, `allow-get-quick-capture-shortcut`.
- À l’appui : fenêtre principale au premier plan et événement `desktop://quick-add` (remplacé par la mini-fenêtre à Q-01). Démarrage : `quickCaptureStore.init()` lit le réglage et enregistre ; un refus donne l’état « indisponible ».

## Avenant F-01 : mini-fenêtre Focus (2026-10-04)

- Seconde fenêtre `focus` (340 × 460, non redimensionnable, toujours au premier plan, hors barre des tâches) créée par la fenêtre principale avec l'API JavaScript (`WebviewWindow`) : **aucune commande ni module Rust ajouté**, donc aucun conflit avec la capture rapide (Q-01). Elle charge le même bundle avec `?window=focus` (`src/main.tsx` : `FocusWindowRoot`), sans base ni conteneur.
- État dans la fenêtre principale (écriture en base), vue pilotée par événements : `focus://state` (photographie de la session : horodatages, jamais un temps restant) de la principale vers `focus`, `focus://action` (ordres : durée, pause, reprise, arrêt, terminer la tâche, autre session, fermer, `elapsed`, `moved`, `ready`) dans l'autre sens. Contrats `FocusWindowPlatform` / `FocusWindowClient` dans `src/platform/focus` (faux mémoire pour les tests, `null` hors Windows installé : la vue s'affiche alors en panneau dans la fenêtre principale).
- Capabilities séparées : `focus-launcher.json` (fenêtre principale : `core:webview:allow-create-webview-window`, afficher, focaliser, restaurer, détruire) et `focus.json` (mini-fenêtre : quatre permissions d'événements, aucune commande de l'application, aucun SQL). `desktop.json` est inchangé. Tests : `src-tauri/tests/desktop/focus.rs` (portée des capabilities, aucun plugin ni API de notification).
- Le PC n'émet que le son de fin (élément `Audio` de la mini-fenêtre) ; aucune notification Windows (PRD section 7, F-04 D1).

## Avenant D-03 : publication (2026-10-04)

- `build-windows.yml` : build signé sur tag `vX.Y.Z` uniquement (le lancement manuel ne reçoit pas les secrets et produit un installeur non signé) ; signature vérifiée hors ligne (`scripts/release/verify-signature.mjs`) avant publication ; publication par le job `publish` (environnement `releases`) qui contrôle version et SHA-256. Processus : `docs/release-pc.md`.
- Limite inhérente : `TAURI_SIGNING_PRIVATE_KEY` est exposée à tout le processus de compilation du build signé (build.rs, scripts npm, dépendances). Atténuations : tags `vX.Y.Z` seulement, cache cargo en lecture seule, dossier `bundle` purgé, option d'un environnement `signing` limité aux tags `v*`.
- Les releases iPhone sont créées avec `--latest=false` : seule une release PC peut être « latest », ce qui garde valide l'endpoint `releases/latest/download/latest.json`.

## Avenant H-03 : export de fichiers (2026-10-04)

- Export par deux commandes Rust (`src-tauri/src/export.rs`) : `export_save_file` ouvre « Enregistrer sous » côté Rust (`tauri-plugin-dialog`, même bloc `cfg(not(any(android, ios)))`, aucune permission `dialog:` pour la WebView), écrit de façon atomique (temporaire puis renommage), refuse au-delà de 64 Mio et hors chemin à lettre de lecteur ; `reveal_exported_file` n'affiche que le dernier fichier écrit. `tauri-plugin-fs` n'est pas utilisé.
- Capability séparée `export.json` (fenêtre `main`, Windows) : uniquement `allow-export-save-file` et `allow-reveal-exported-file`. `desktop.json` est inchangé. Détails, contrat `FileService` et taille : ADR 0009 et docs/decisions.md (H-03, « Permissions Tauri »).

## Avenant : taille mesurée de l'installeur v0.1.0 (2026-10-05)

- Mesure (audit de fin d'ordre 3) : l'installeur de la release v0.1.0 fait **5 491 442 octets (5,24 Mo)**, contre 2,70 Mo mesurés le 2026-10-02 (section « Taille de l'installeur »). Il reste sous le budget de 15 Mo (PRD 8), avec une marge de ~9,8 Mo.
- La mesure du 2026-10-02 date d'avant les ordres 2 et 3 ; elle n'est plus représentative et est remplacée par celle-ci.

### Causes probables de l'écart (hypothèses, non vérifiées)

L'écart (+2,54 Mo) n'a pas été décomposé. Les pistes ci-dessous sont des hypothèses à confirmer par une mesure ; aucune n'est établie.

1. **Ressources OCR sous `/ocr/` (hypothèse principale).** `vite.ocrAssets.ts` (Q-04) copie dans `dist/ocr/` le worker tesseract.js (~111 Ko), le noyau WebAssembly `tesseract-core-simd-lstm.wasm.js` (~3,9 Mo) et `lang/fra.traineddata.gz` (~707 Ko). `tauri.conf.json` ne déclare aucun `bundle.resources` : ces fichiers entrent dans l'exécutable par `build.frontendDist` (`../dist`), comme tout le front. Le noyau se compresse (compression des ressources du front par Tauri, puis compression NSIS) ; les données françaises, déjà en gzip, presque pas. Ordre de grandeur plausible : 1,5 à 2,5 Mo. Commit Q-04 (72cec4f) antérieur au tag v0.1.0.
2. **Polices.** Les quatre fichiers woff2 (~182 Ko) étaient déjà présents dans le build du 2026-10-02 et le woff2 ne se recompresse pas : contribution à l'écart probablement nulle ou faible. À confirmer seulement si les autres pistes n'expliquent pas tout.
3. **Artefacts de l'updater.** La release est produite par `build-windows.yml` avec `createUpdaterArtifacts: true`, alors que la mesure du 2026-10-02 venait d'un `npm run tauri build` local sans cette option. Pour NSIS, l'artefact de mise à jour est l'installeur lui-même accompagné d'un `.sig` séparé : effet attendu faible sur la taille de l'`.exe`. Il faut toutefois vérifier que les 5 491 442 octets sont bien ceux de `CircleTasks_0.1.0_x64-setup.exe` et non d'une archive ou d'un autre fichier de la release.
4. **Code Rust ajouté après le 2026-10-02** (piste complémentaire) : `reqwest` et `rustls` (K-01), `rusqlite`, `keyring`, la crate `windows` avec `Media_Ocr` (Q-04), `tauri-plugin-dialog` (H-03), `tauri-plugin-global-shortcut` (D-04), `tokio`. Malgré le profil release optimisé pour la taille, quelques centaines de Ko sont plausibles.

Vérification proposée (agent performance ou desktop-tauri) : comparer la taille de `dist/` avec et sans `dist/ocr/`, puis celle de l'installeur produit par un build local sans le plugin `ocrAssets` ; `cargo bloat --release` pour la part Rust.

### Suivi

- La taille de l'installeur sera **mesurée à chaque release** (octets et Mo, version, date) et consignée dans cet ADR à la suite de cet avenant ; un écart de plus de 1 Mo d'une release à l'autre doit être expliqué dans les notes de la release.
- Seuil d'alerte : au-delà de 10 Mo, une revue de taille est obligatoire avant publication (budget de 15 Mo, PRD 8).
- Si l'OCR est confirmé comme cause principale, les options (alléger le noyau ou les données, ou ne pas embarquer le repli tesseract.js dans l'installeur PC si Windows.Media.Ocr couvre les cas visés par Q-04) seront étudiées dans un ADR séparé ; rien n'est décidé ici.

| Version | Date | Installeur NSIS | Source |
| --- | --- | --- | --- |
| 0.1.0 (build local) | 2026-10-02 | 2,70 Mo | `npm run tauri build` |
| 0.1.0 (release) | 2026-10-05 | 5 491 442 octets (5,24 Mo) | release GitHub v0.1.0 |
