# ADR 0007 — Build iPhone sans Mac

- Statut : accepté (build sans signature confirmé par POC-01, voir avenant)
- Date : 2026-10-03
- Tâches : POC-01 (ordre 1 bis, agents ci-release et ios-mobile)

## Contexte

Pas de Mac, pas de compte Apple Developer payant (PRD sections 2 et 7). L'IPA doit être compilée dans le cloud puis installée et re-signée par SideStore avec un Apple ID gratuit.

## Décision

- **Workflow** `.github/workflows/build-ios.yml` : runner `macos-latest`, déclenché uniquement à la main (`workflow_dispatch`) ou sur tag `ios-v*` (distinct du tag PC `vX.Y.Z` ; le tag doit égaler `ios-v` + version de `tauri.conf.json`, sinon échec). Les minutes macOS d'un dépôt privé sont facturées 10 fois ; aucun déclenchement sur push.
- **Projet Xcode non versionné** : `src-tauri/gen/` est ignoré par git et régénéré à chaque build par `tauri ios init`. Les réglages durables sont dans `tauri.conf.json` (`identifier` `fr.circletasks.planner`, `bundle.iOS.minimumSystemVersion` 18.0) et `src-tauri/Info.ios.plist` (portrait seul, aucune permission : caméra, micro, notifications, rappels arrivent à l'ordre 5).
- **Compilation sans signature** : `tauri ios build --no-sign` (option officielle) compile front, Rust et archive Xcode sans signature, puis produit `CircleTasks.ipa` (`Payload/`), téléversée en artefact. SideStore signe sur l'iPhone. Détails : avenant POC-01.
- **Publication** : job `publish` séparé (`needs: ios`, permissions `contents: read`, permissions minimales par job), lancé si input `publish` (faux par défaut) ou tag `ios-v*`. Il utilise l'environnement GitHub `releases`, **que Ali crée** (Settings > Environments > New environment « releases », règle « Required reviewers » = lui-même) : chaque publication attend son approbation. Le secret `RELEASES_TOKEN` (jeton à portée limitée au dépôt `circletasks-releases`, droit contenu en écriture) est de préférence défini comme secret de cet environnement ; absent, le job échoue. Le jeton passe par `gh auth setup-git`, jamais dans une URL. L'IPA va dans une release `ios-vX.Y.Z` (distincte du tag `vX.Y.Z` PC du même dépôt) ; `source.json` (format source SideStore, modèle `scripts/ios/source.template.json`, généré par `make-source-json.mjs`, anciennes versions conservées) est commité sur `main` ; URL de la source : `https://raw.githubusercontent.com/doncivo/circletasks-releases/main/source.json`.
- **Rust** : plugins PC (`single-instance`, `autostart`, `updater`, `process`, `opener`) sont dans `[target.'cfg(not(any(android, ios)))'.dependencies]`, le module `desktop` sous `cfg(desktop)`. Vérifié par `cargo tree --target aarch64-apple-ios` : aucun plugin PC ni `tray-icon`. `cargo check` complet impossible sous Windows (les dépendances C comme SQLite exigent `xcrun`) : la compilation est vérifiée par le runner macOS.
- **Tests** : `tests.yml` (ubuntu) lint, typecheck, Vitest sur push et PR ; Playwright à la demande.

## Conséquences et risques

- Le build dépend de l'option `--no-sign` du CLI Tauri : vérifier les notes de version à chaque montée de `@tauri-apps/cli`.
- Un Apple ID gratuit limite à 3 apps et 7 jours de validité (guide `docs/install-iphone.md`).
- Si la chaîne échoue durablement, repli PWA (PRD section 10).
- Aucun secret dans les fichiers ; le jeton n'existe que dans GitHub Secrets.

## Avenant POC-01 (2026-10-04) — compilation par `tauri ios build --no-sign`

- **Constats** : run 1, `tauri ios build --ci` sans option échoue à `xcodebuild` (« Signing for "circletasks_iOS" requires a development team »), avant toute compilation Rust. Run 2, `xcodebuild` lancé seul : la phase « Build Rust Code » (`tauri ios xcode-script`) échoue car elle lit `gen/apple/.tauri/cli-options-server.json`, écrit par `tauri ios build|dev` en cours d'exécution.
- **Source vérifiée** (tauri-cli 2.12.1, `crates/tauri-cli/src/mobile/mod.rs`) : ce fichier pointe vers un serveur WebSocket local protégé par un jeton aléatoire, vivant le temps de la commande `tauri ios build`. Il n'est donc ni falsifiable proprement ni réutilisable après coup.
- **Décision** : `npx tauri ios build --ci --no-sign --target aarch64`. L'option officielle `--no-sign` (`mobile/ios/build.rs`) saute le `xcodebuild build` signé, lance `xcodebuild archive` avec `CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO` pendant que le serveur d'options est actif, puis zippe `Products/Applications/CircleTasks.app` en `Payload/` dans `gen/apple/build/arm64/CircleTasks.ipa`. `beforeBuildCommand` compile le front, embarqué dans le binaire Rust.
- **Pistes écartées** : compiler `libapp.a` par `cargo` puis neutraliser la phase Xcode par remplacement dans `project.pbxproj` (reproduit à la main les variables d'environnement de `xcode-script`, casse au moindre changement du modèle généré) ; `tauri ios build` en arrière-plan pendant un `xcodebuild` séparé (course entre deux processus, verrou `lock.ios`).
- **Contrôles du workflow** sur l'IPA : `CFBundleIdentifier` = `fr.circletasks.planner`, `MinimumOSVersion` = 18.0, binaire `arm64` (`lipo`), chemins `/index.html` et premier `assets/*.js` du front présents dans le binaire. Échec explicite sinon.
- **Risque** : l'IPA n'a aucune signature ni profil ; SideStore la signe avec l'Apple ID gratuit. Les droits (entitlements) du projet ne sont pas appliqués au build : à revérifier à l'ordre 5 (Face ID, notifications).

## Avenant I-01 (2026-10-07) — build par branche, contrat Info.plist, source SideStore

- **Build par branche** : `gh workflow run build-ios.yml --ref <branche> -f publish=false` produit l'IPA en artefact. Le job `publish` ne tourne que sur un tag `ios-v*` (push du tag, ou lancement manuel sur ce tag avec `publish`) ; le script de publication refuse aussi tout `GITHUB_REF` hors `refs/tags/ios-v*`. L'input `publish` coché sur une branche ne publie rien.
- **Contrat des permissions** : `scripts/ios/plist-contract.json` liste, par plugin, les descriptions d'usage (`usageDescriptions`), les clés présentes (`keys`) et les valeurs de tableau (`arrayIncludes`). L'étape « Contrat des permissions Info.plist » convertit le Info.plist de l'IPA en XML (`plutil`) et lance `check-plist-contract.mjs` : clé manquante ou description d'usage vide (déclarée ou non) = échec ; description non déclarée = avertissement. Le même contrôle porte sur `src-tauri/Info.ios.plist` dans Vitest. Chaque lot de plugin ajoute son entrée.
- **Source SideStore** (champs relus dans le code de SideStore, branche develop : `StoreApp.swift`, `AppVersion.swift`, `VerifyAppOperation.swift`) : `iconURL` obligatoire (icône `icon.png` copiée dans circletasks-releases), `buildVersion` (CFBundleVersion), `sha256` (vérifié par SideStore à l'installation), taille exacte, `appPermissions.privacy` tiré du Info.plist de l'IPA (informatif : la source reste au format 1, sans vérification des permissions), champs d'app hérités pour les anciennes versions de SideStore. La version, le bundle et l'iOS minimum de l'IPA sont comparés avant publication (SideStore refuse sinon l'installation). Toutes les versions publiées sont conservées.
