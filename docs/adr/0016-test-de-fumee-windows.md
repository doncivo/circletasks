# ADR 0016 — Test de fumée du vrai binaire Windows

- Statut : accepté (contrat ; implémentation par desktop-tauri et qa-test, relectures code-reviewer et security-privacy)
- Date : 2026-10-10
- Story : REL-TECH-01 (décision d'Ali du 2026-10-10 : « Ajoute un test de fumée qui lance le vrai binaire Windows et vérifie que l'écran du jour s'affiche. Un écran noir au démarrage ne doit jamais pouvoir passer inaperçu. »)
- Complète : ADR 0006 (fenêtre `main` masquée puis affichée, zone de notification, instance unique, raccourci global), ADR 0007 (`tests.yml`), ADR 0014 (journal technique)

## Contexte

Le 2026-10-10, la 0.3.1 lancée en dev a affiché une fenêtre **entièrement noire** au démarrage. Le journal technique (ADR 0014) prouvait un démarrage JavaScript complet. Cause environnementale : runtime WebView2 mis à jour à 3 h 23 ; l'app s'affichait normalement après redémarrage.

Trou constaté dans la suite :

- les e2e `pc` tournent dans Chromium et WebKit de Playwright contre le serveur Vite, jamais dans la fenêtre Tauri réelle ni dans WebView2 ;
- `cargo test` (ADR 0006, section Tests) n'ouvre aucune fenêtre ;
- un défaut au niveau fenêtre Win32, WebView2 ou compositeur est donc invisible pour la suite, même quand le DOM est parfait.

## Décision

### 1. Binaire testé

- Commande : `npm run test:smoke:build` (`node scripts/smoke/build.mjs` : `tauri build --debug --no-bundle --config src-tauri/tauri.smoke.conf.json` avec `CARGO_TARGET_DIR=src-tauri/target/smoke`), qui produit `src-tauri/target/smoke/debug/circletasks.exe` (binaire `[[bin]] circletasks`). Dossier cargo dédié : le binaire de `tauri dev` (`target/debug/circletasks.exe`) peut tourner pendant le test en local sans verrouiller le build (constaté le 2026-10-10 : « Accès refusé » à la relinking du binaire ouvert).
- Le front est **embarqué** dans le binaire (`build.frontendDist` = `../dist`, compilé par `beforeBuildCommand`) : aucun serveur Vite, aucun `devUrl`. C'est le même chemin de chargement que l'app installée (ressources servies par le binaire).
- **Debug et non release** : le profil release (`lto = true`, `codegen-units = 1`, `opt-level = "s"`, `src-tauri/Cargo.toml`) allonge fortement l'édition des liens en CI pour un gain nul ici. Le chemin de démarrage Rust (`setup`, plugins, fenêtre masquée puis affichée) et JavaScript (même `dist/`) est identique entre les deux profils ; seules l'optimisation, `strip` et `panic = "abort"` diffèrent.
- **Pas l'installeur NSIS** : il écrirait dans `%LOCALAPPDATA%\Programs` et le registre de désinstallation, et imposerait une désinstallation à la fin ; il testerait l'installeur (couvert par `build-windows.yml` et la vérification de signature, ADR 0006 avenant D-03), pas l'affichage. `--no-bundle` évite aussi toute clé de signature : aucun secret dans ce job.

### 2. Isolation

- `src-tauri/tauri.smoke.conf.json` surcharge `identifier` en **`fr.circletasks.planner.smoke`**. Le dossier de données AppData (base SQLite, réglages), le dossier WebView2 (`EBWebView`) et le verrou de `tauri-plugin-single-instance` sont ainsi distincts de l'app installée et de l'app de dev : le test peut tourner sur le PC d'Ali pendant que CircleTasks est ouvert, sans réveiller l'instance existante ni toucher à ses données.
- Le tableau `app.windows` est remplacé en entier par la fusion de configuration (même règle que `tauri.windows.conf.json`, ADR 0006 D-01) : la surcharge **répète la fenêtre `main` de `tauri.windows.conf.json`** et n'y ajoute que `additionalBrowserArgs`. Un test Vitest de cohérence vérifie l'égalité des deux définitions hors ce champ.
- Le test **efface le dossier de l'identifiant `.smoke`** avant le lancement : chaque exécution est un premier lancement réel (migrations depuis une base vide, guide de bienvenue). Le guide est fermé par le bouton « Passer le guide de bienvenue » (rôle et nom accessibles, texte tiré de `src/i18n`). Garde-fou : refus d'effacer si le chemin calculé ne se termine pas par `fr.circletasks.planner.smoke`.
- C'est le **seul dossier hors du dépôt** écrit, et il l'est par l'app elle-même, comme à tout lancement. Rapport, capture et traces vont dans `test-results/smoke/` du dépôt.

### 3. Observation

- Fenêtre `main` de la surcharge : `additionalBrowserArgs` = `--remote-debugging-port=9377 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required`. Dès que l'hôte fixe `additionalBrowserArgs`, wry n'ajoute plus ses arguments par défaut : ils sont **recopiés** pour garder le comportement de l'app livrée.
- Pas de variable `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` : WebView2 l'ignore quand l'hôte fixe ses propres arguments (constaté le 2026-10-10).
- Pilotage : Playwright `chromium.connectOverCDP("http://127.0.0.1:9377")` (`@playwright/test`, déjà présent : **aucune dépendance ajoutée**). Attente bornée de l'ouverture du port, puis sélection de la page de la fenêtre `main`.
- Écartés : `tauri-driver` + `msedgedriver` (la version du pilote doit égaler celle du runtime WebView2, qui se met à jour seul, précisément la cause du 2026-10-10 : appariement fragile) ; WebdriverIO (dépendance de plus pour le même résultat).
- Sécurité : le port de débogage n'existe **que** dans `tauri.smoke.conf.json`, jamais dans un build livré. Le test de cohérence Vitest et les garde-fous de configuration de `cargo test` (ADR 0006) refusent toute occurrence de `remote-debugging` dans `tauri.conf.json` et `tauri.windows.conf.json`.

### 4. Deux niveaux de vérification, tous deux bloquants

**Niveau DOM (par CDP)**, après passage du guide :

- `.app-shell[data-db-status="ready"]` présent ;
- onglet Tâches courant dans la navigation ;
- `h1` égal à la date du jour **locale** formatée comme l'écran du jour (formateur de `src/i18n`, fuseau de la machine) ;
- badge « Aujourd'hui » visible ;
- aucun élément `role="alert"` (bandeau d'erreur, base indisponible : « aucun échec silencieux »).

**Niveau pixels (fenêtre Win32 réelle)** : `tests/smoke/window-capture.ps1`, appelé par le test avec le PID du processus :

- recherche de la fenêtre de premier niveau du processus ; capture par `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)` (valeur 2 : capture le contenu composé par DirectComposition de WebView2, que `PrintWindow` sans cet indicateur rend noir) ;
- **échec** si : fenêtre absente, invisible (`IsWindowVisible`), réduite (`IsIconic`), zone cliente sous **1024 × 700**, ou au moins **95 %** des pixels échantillonnés (grille régulière) quasi noirs, soit `max(R, G, B) < 12` ;
- le thème sombre de l'app a un fond vers (26, 21, 48) : `max` = 48, jamais confondu avec le noir du défaut ;
- sortie JSON (`found`, `visible`, `iconic`, `width`, `height`, `darkRatio`, chemin du PNG) lue par le test ; le PNG est **joint au rapport Playwright** (`testInfo.attach`), en succès comme en échec.

**Pourquoi le DOM seul ne suffit pas** : le 2026-10-10, le DOM était complet (le journal le prouve) et la fenêtre noire. Seule l'image réellement composée par Windows révèle un défaut WebView2 ou compositeur. Inversement, les pixels seuls ne disent pas que l'écran affiché est le bon : les deux niveaux sont requis.

### 5. Exécution

- Scripts npm : `test:smoke:build` (commande de la section 1) puis `test:smoke` (`playwright test --config playwright.smoke.config.ts`).
- `playwright.smoke.config.ts` : `testDir: "tests/smoke"`, `workers: 1`, `retries: 0`, **aucun `webServer`**, sortie `test-results/smoke/`. Délais fixés une fois à la création, jamais allongés pour faire passer un essai (CLAUDE.md).
- Lancement par le test : `circletasks.exe` sans `--minimized` (la fenêtre doit s'afficher d'elle-même, ADR 0006 D-01).
- Fin : le processus est **tué** (`taskkill /PID <pid> /T /F`, en `afterAll`, échec compris) : fermer la fenêtre ne fait que la cacher dans la zone de notification, et « Quitter » ajoute une attente sans intérêt ici.
- CI : job **`smoke-windows`** (`runs-on: windows-latest`) dans `.github/workflows/tests.yml`, ajouté aux `needs` de `suite-verte` : une fusion dans `main` l'exige. Rapport et capture téléversés en artefact.
- En local : seulement à la demande (build de plusieurs minutes), conformément à la méthode du 2026-10-08.

### Fichiers impactés

| Fichier | Rôle |
| --- | --- |
| `src-tauri/tauri.smoke.conf.json` (nouveau) | identifiant `.smoke`, fenêtre `main` répétée avec `additionalBrowserArgs` |
| `playwright.smoke.config.ts` (nouveau) | configuration dédiée, 1 worker, 0 nouvel essai, aucun `webServer` |
| `tests/smoke/*.spec.ts` (nouveau) | effacement, lancement, CDP, vérifications DOM et pixels, arrêt |
| `tests/smoke/window-capture.ps1` (nouveau) | capture `PrintWindow` et mesures de la fenêtre |
| `package.json` | scripts `test:smoke:build`, `test:smoke` |
| `.github/workflows/tests.yml` | job `smoke-windows`, `needs` de `suite-verte` |
| Vitest de cohérence de configuration, `src-tauri/tests/desktop` | égalité des fenêtres, absence de `remote-debugging` hors surcharge |

## Conséquences

- Un écran noir, une fenêtre absente, invisible ou réduite au démarrage fait échouer « suite verte » : aucune fusion possible.
- Toute modification de la fenêtre `main` dans `tauri.windows.conf.json` doit être reportée dans `tauri.smoke.conf.json` (le test de cohérence l'impose).
- La CI gagne un build debug Windows, exécuté en parallèle des autres jobs.
- Aucun secret, aucune dépendance npm ou cargo ajoutée.

### Limites et points ouverts

- **Build debug** : un défaut propre au profil release (optimisation, `strip`, `panic = "abort"`) n'est pas couvert ; l'installeur publié reste vérifié par `build-windows.yml` et le test de mise à jour.
- **Thème du runner** : le thème suivi dépend du réglage Windows du runner (clair par défaut sur `windows-latest`) ; seul ce thème est vérifié au niveau pixels. Le seuil reste valable pour les deux thèmes ; forcer le thème sombre est un point ouvert, non requis par REL-TECH-01.
- **Autres fenêtres** : Capture rapide (Q-01) et Focus (F-01) ne sont pas vérifiées ; seul l'écran du jour de la fenêtre `main` l'est.
- **Raccourci global** : sur le runner, `Ctrl+Alt+Space` peut être refusé (`shortcut-in-use`) sans effet sur le test ; l'état « indisponible » est normal (ADR 0006 avenant D-04) et ne doit lever aucun `role="alert"`.
- **iPhone** : aucun équivalent (pas de Mac, pas de simulateur) ; un écran noir sur iPhone n'est détecté qu'à la vérification après installation par SideStore.

## Tests

- Le test de fumée lui-même (`tests/smoke`), bloquant dans le job `smoke-windows`.
- Vitest : cohérence `tauri.smoke.conf.json` / `tauri.windows.conf.json` (fenêtre `main` identique hors `additionalBrowserArgs`, identifiant `.smoke`, arguments par défaut de wry présents, port 9377) ; absence de `remote-debugging` dans les configurations livrées.
- `cargo test` (`src-tauri/tests/desktop`, garde-fous de configuration) : même refus de `remote-debugging` dans `tauri.conf.json` et `tauri.windows.conf.json`.
- Efficacité du contrôle pixels prouvée à chaque exécution : `window-capture.ps1 -SelfTest` mesure une image noire (100 % de pixels quasi noirs, une seule couleur) et une image au thème sombre de l’app (0 %), premier test de `tests/smoke/pc-demarrage.spec.ts`.
