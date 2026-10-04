# Publier une version PC

Workflow : `.github/workflows/build-windows.yml` (story D-03, critères 10 et 11, ADR 0006). L'app installée vérifie `https://github.com/doncivo/circletasks-releases/releases/latest/download/latest.json` (`plugins.updater.endpoints` dans `src-tauri/tauri.conf.json`).

## Réglages à faire une fois (PREP-01)

1. Dépôt public `doncivo/circletasks-releases` créé.
2. Secrets du dépôt CircleTasks (Settings > Secrets and variables > Actions) : `TAURI_SIGNING_PRIVATE_KEY` (contenu de la clé privée `tauri signer generate`) et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Environnement `releases` (Settings > Environments), avec « Required reviewers » = toi, et son secret `RELEASES_TOKEN` (jeton limité à circletasks-releases, droit « Contents : écriture »). Le même environnement sert à la publication iPhone.
4. La clé publique correspondante est déjà dans `plugins.updater.pubkey`.

## Publier X.Y.Z

1. Mettre la même version dans `package.json`, `src-tauri/tauri.conf.json` et `src-tauri/Cargo.toml` (et `Cargo.lock` via `cargo check`). Mettre à jour le CHANGELOG : si `CHANGELOG.md` contient un titre `## ... X.Y.Z ...`, son contenu devient les notes de la mise à jour, sinon « CircleTasks X.Y.Z ».
2. Valider sur `main` (tests verts), puis créer et pousser le tag : `git tag vX.Y.Z` puis `git push origin vX.Y.Z`. Seuls les tags `vX.Y.Z` déclenchent ce workflow (`ios-vX.Y.Z` est pour l'iPhone).
3. Job `windows` (windows-latest) : vérifie que tag, `tauri.conf.json`, `package.json` et `Cargo.toml` ont la même version (échec sinon) ; `npm ci` ; `tauri build` NSIS avec `createUpdaterArtifacts` activé par `--config` (non activé dans le fichier, pour que les builds locaux n'exigent pas la clé) ; produit `CircleTasks_X.Y.Z_x64-setup.exe`, son `.sig` et `latest.json` (artefact `CircleTasks-windows`, 30 jours).
4. Job `publish` : attend ton approbation (environnement `releases`), puis crée la release `vX.Y.Z` de circletasks-releases, marquée « latest », avec l'installeur, le `.sig` et `latest.json`. Comme l'endpoint est `releases/latest/download/latest.json`, c'est la release la plus récente qui sert l'updater. Relancer le job est sans danger (fichiers remplacés).
5. Vérifier : ouvrir `https://github.com/doncivo/circletasks-releases/releases/latest/download/latest.json` (version, signature, URL). Une app en X.Y.(Z-1) propose alors la mise à jour au prochain contrôle (5 s après le lancement, puis toutes les 24 h, ou Réglages > À propos).

## Lancement manuel

« Run workflow » construit l'installeur et l'envoie en artefact, sans publier. Sans clé de signature, l'installeur est non signé et `latest.json` n'est pas produit (avertissement).

## Points d'attention

- Les releases iPhone (`ios-vX.Y.Z`) sont créées avec `--latest=false` : sinon la plus récente deviendrait « latest » et l'endpoint de l'updater PC ne trouverait plus `latest.json`.
- `requireSignedVersion` : la version annoncée dans `latest.json` doit égaler celle du commentaire signé du paquet ; ne jamais modifier `latest.json` à la main.
- Aucun secret n'est écrit dans le dépôt ni dans les journaux ; la clé n'est exposée qu'à l'étape de compilation.
- Scripts : `scripts/release/check-version.mjs` (cohérence des versions, `node scripts/release/check-version.mjs vX.Y.Z` en local) et `scripts/release/make-latest-json.mjs`.
