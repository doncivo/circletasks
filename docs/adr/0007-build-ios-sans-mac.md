# ADR 0007 — Build iPhone sans Mac

- Statut : accepté (à confirmer par le premier run, POC-01)
- Date : 2026-10-03
- Tâches : POC-01 (ordre 1 bis, agents ci-release et ios-mobile)

## Contexte

Pas de Mac, pas de compte Apple Developer payant (PRD sections 2 et 7). L'IPA doit être compilée dans le cloud puis installée et re-signée par SideStore avec un Apple ID gratuit.

## Décision

- **Workflow** `.github/workflows/build-ios.yml` : runner `macos-latest`, déclenché uniquement à la main (`workflow_dispatch`) ou sur tag `ios-v*` (distinct du tag PC `vX.Y.Z` ; le tag doit égaler `ios-v` + version de `tauri.conf.json`, sinon échec). Les minutes macOS d'un dépôt privé sont facturées 10 fois ; aucun déclenchement sur push.
- **Projet Xcode non versionné** : `src-tauri/gen/` est ignoré par git et régénéré à chaque build par `tauri ios init`. Les réglages durables sont dans `tauri.conf.json` (`identifier` `fr.circletasks.planner`, `bundle.iOS.minimumSystemVersion` 18.0) et `src-tauri/Info.ios.plist` (portrait seul, aucune permission : caméra, micro, notifications, rappels arrivent à l'ordre 5).
- **Compilation sans signature** : `tauri ios build` prépare front et bibliothèque Rust (échec d'archive toléré), puis `xcodebuild` avec `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`. Le `.app` est copié dans `Payload/`, zippé en `CircleTasks.ipa`, téléversé en artefact. SideStore signe sur l'iPhone.
- **Publication** : job `publish` séparé (`needs: ios`, permissions `contents: read`, permissions minimales par job), lancé si input `publish` (faux par défaut) ou tag `ios-v*`. Il utilise l'environnement GitHub `releases`, **que Ali crée** (Settings > Environments > New environment « releases », règle « Required reviewers » = lui-même) : chaque publication attend son approbation. Le secret `RELEASES_REPO_TOKEN` (jeton à portée limitée au dépôt `circletasks-releases`, droit contenu en écriture) est de préférence défini comme secret de cet environnement ; absent, le job échoue. Le jeton passe par `gh auth setup-git`, jamais dans une URL. L'IPA va dans une release `ios-vX.Y.Z` (distincte du tag `vX.Y.Z` PC du même dépôt) ; `source.json` (format source SideStore, modèle `scripts/ios/source.template.json`, généré par `make-source-json.mjs`, anciennes versions conservées) est commité sur `main` ; URL de la source : `https://raw.githubusercontent.com/doncivo/circletasks-releases/main/source.json`.
- **Rust** : plugins PC (`single-instance`, `autostart`, `updater`, `process`, `opener`) sont dans `[target.'cfg(not(any(android, ios)))'.dependencies]`, le module `desktop` sous `cfg(desktop)`. Vérifié par `cargo tree --target aarch64-apple-ios` : aucun plugin PC ni `tray-icon`. `cargo check` complet impossible sous Windows (les dépendances C comme SQLite exigent `xcrun`) : la compilation est vérifiée par le runner macOS.
- **Tests** : `tests.yml` (ubuntu) lint, typecheck, Vitest sur push et PR ; Playwright à la demande.

## Conséquences et risques

- Étape `tauri ios build` + `xcodebuild` en deux temps : fragile, le script de phase Rust d'Xcode attend normalement le CLI Tauri. Premier run à surveiller ; repli : `tauri ios build` seul avec export non signé, puis extraction du `.app` de l'archive.
- Un Apple ID gratuit limite à 3 apps et 7 jours de validité (guide `docs/install-iphone.md`).
- Si la chaîne échoue durablement, repli PWA (PRD section 10).
- Aucun secret dans les fichiers ; le jeton n'existe que dans GitHub Secrets.
