# Publier une version PC

Workflow : `.github/workflows/build-windows.yml` (story D-03, critères 10 et 11, ADR 0006). L'app installée vérifie `https://github.com/doncivo/circletasks-releases/releases/latest/download/latest.json` (`plugins.updater.endpoints` dans `src-tauri/tauri.conf.json`).

## Réglages à faire une fois (PREP-01)

1. Dépôt public `doncivo/circletasks-releases` créé.
2. Secrets du dépôt CircleTasks (Settings > Secrets and variables > Actions) : `TAURI_SIGNING_PRIVATE_KEY` (contenu de la clé privée `tauri signer generate`) et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Environnement `releases` (Settings > Environments), avec « Required reviewers » = toi, et son secret `RELEASES_TOKEN` (jeton limité à circletasks-releases, droit « Contents : écriture »). Le même environnement sert à la publication iPhone.
4. La clé publique correspondante est déjà dans `plugins.updater.pubkey`.
5. Étape ponctuelle : la release `ios-v0.1.0` existante ne doit pas rester « latest » (sinon l'endpoint de l'updater ne trouve plus `latest.json`) : `gh release edit ios-v0.1.0 --repo doncivo/circletasks-releases --latest=false`. Les releases iPhone suivantes sont créées avec `--latest=false` par `build-ios.yml`.

### Réglages recommandés (à faire par Ali)

- Environnement `releases` : « Deployment branches and tags » limité aux tags `v*` et `ios-v*` et à la branche `main`.
- `RELEASES_TOKEN` uniquement en secret d'environnement `releases` (jamais en secret de dépôt).
- Option : un environnement `signing`, limité aux tags `v*`, qui porte les deux secrets de signature à la place des secrets de dépôt (le job `windows` y ferait référence par `environment: signing`). Sans cela, les secrets de dépôt restent lisibles par tout workflow du dépôt.

## Publier X.Y.Z

1. Mettre la même version dans `package.json`, `src-tauri/tauri.conf.json` et `src-tauri/Cargo.toml` (et `Cargo.lock` via `cargo check`). Mettre à jour le CHANGELOG : si `CHANGELOG.md` contient un titre `## X.Y.Z` ou `## [X.Y.Z]` (correspondance exacte), son contenu devient les notes de la mise à jour, sinon « CircleTasks X.Y.Z ».
2. Valider sur `main` (tests verts), puis créer et pousser le tag : `git tag vX.Y.Z` puis `git push origin vX.Y.Z`. Seuls les tags `vX.Y.Z` déclenchent ce workflow (`ios-vX.Y.Z` est pour l'iPhone).
3. Job `windows` (windows-latest) : vérifie que tag, `tauri.conf.json`, `package.json` et `Cargo.toml` ont la même version (échec sinon) ; `npm ci` ; supprime tout dossier `bundle` résiduel ; `tauri build` NSIS avec `createUpdaterArtifacts` activé par `--config` (non activé dans le fichier, pour que les builds locaux n'exigent pas la clé) ; produit `CircleTasks_X.Y.Z_x64-setup.exe`, son `.sig` et `latest.json`. Il vérifie ensuite la signature hors ligne (`scripts/release/verify-signature.mjs` : ID de clé, signature Ed25519 du fichier, signature globale, `version:X.Y.Z` dans le commentaire de confiance) avec la clé publique de `tauri.conf.json`, puis dépose le tout en artefact `CircleTasks-windows` (30 jours). Sur tag, le cache cargo est restauré en lecture seule.
4. Job `publish` (uniquement sur push de tag) : attend ton approbation (environnement `releases`), contrôle que `latest.json` annonce la version du tag et que le SHA-256 de l'installeur est celui vérifié par le job `windows`, puis crée la release `vX.Y.Z` de circletasks-releases, marquée « latest », avec l'installeur, le `.sig` et `latest.json`. Comme l'endpoint est `releases/latest/download/latest.json`, c'est la release la plus récente qui sert l'updater. Relancer le job est sans danger (fichiers remplacés).
5. Vérifier : ouvrir `https://github.com/doncivo/circletasks-releases/releases/latest/download/latest.json` (version, signature, URL). Une app en X.Y.(Z-1) propose alors la mise à jour au prochain contrôle (5 s après le lancement, puis toutes les 24 h, ou Réglages > À propos).

## Lancement manuel

« Run workflow » (même sur une référence de tag) construit l'installeur et l'envoie en artefact, sans publier et sans signer : le build manuel n'a jamais accès aux secrets de signature, et n'émet ni `.sig` ni `latest.json`.

## Points d'attention

- `requireSignedVersion` : la version annoncée dans `latest.json` doit égaler celle du commentaire signé du paquet ; ne jamais modifier `latest.json` à la main. Si le CLI Tauri n'écrit pas `version:X.Y.Z` dans le commentaire de confiance, la vérification du workflow échoue : c'est voulu (l'app refuserait le paquet de toute façon).
- Aucun secret n'est écrit dans le dépôt ni dans les journaux. Limite inhérente : la clé privée est visible de tout le processus de compilation du build signé (build.rs, scripts npm, dépendances) ; elle n'est donnée qu'aux tags `vX.Y.Z`, et le cache est en lecture seule pour ce build. Garder les dépendances sous contrôle (audit, `npm ci`, `Cargo.lock` versionné).
- Scripts : `scripts/release/check-version.mjs`, `make-latest-json.mjs`, `verify-signature.mjs` ; tests : `npx vitest run scripts/release --coverage.enabled=false`.
