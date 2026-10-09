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
- **Publication** : job `publish` séparé (`needs: ios`, permissions `contents: read`, permissions minimales par job), lancé si input `publish` (faux par défaut) ou tag `ios-v*`. Il utilise l'environnement GitHub `releases`, **que Ali crée** (Settings > Environments > New environment « releases », règle « Required reviewers » = lui-même) : chaque publication attend son approbation. **Avenant 2026-10-07 : plus d'approbation manuelle sur `releases`, voir docs/decisions.md (décision d'Ali).** Le secret `RELEASES_TOKEN` (jeton à portée limitée au dépôt `circletasks-releases`, droit contenu en écriture) est de préférence défini comme secret de cet environnement ; absent, le job échoue. Le jeton passe par `gh auth setup-git`, jamais dans une URL. L'IPA va dans une release `ios-vX.Y.Z` (distincte du tag `vX.Y.Z` PC du même dépôt) ; `source.json` (format source SideStore, modèle `scripts/ios/source.template.json`, généré par `make-source-json.mjs`, anciennes versions conservées) est commité sur `main` ; URL de la source : `https://raw.githubusercontent.com/doncivo/circletasks-releases/main/source.json`.
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

## Avenant I-06 (2026-10-09) — mise à jour par SideStore

Fiche `docs/stories/I-06.md`, décision 2026-10-09 (I-06) de `docs/decisions.md`. SideStore installe ; CircleTasks est compatible, le dit et ne perd rien. Aucune dépendance, aucun plugin, aucune capability (`getVersion` est couvert par `core:default`), aucune migration de base, aucune clé `Info.plist`, `SYNC_FORMAT_MAJOR` inchangé. **Prérequis : `lot-f-ios` (P-04-iOS, I-04) fusionné** ; la branche `i-06` ne le contient pas encore et `openBackupService` y rend un service indisponible sur iOS.

**1. Version lue par l'app** (`src/platform/appVersion.ts`, nouveau, seul lecteur de la version)

```ts
export type AppVersionRead =
  | { readonly ok: true; readonly version: string; readonly source: 'runtime' | 'build' }
  | { readonly ok: false; readonly version: null };
/** `getVersion()` de `@tauri-apps/api/app`, sinon la constante de build ; jamais `0.0.0`. Mémorisée pour le processus. */
export function readAppVersion(deps?: { getVersion?: () => Promise<string>; buildVersion?: string }): Promise<AppVersionRead>;
/** Valeur publiée par la synchro quand `ok` est faux (dans le format, `appVersion` est OBLIGATOIRE). */
export const UNKNOWN_APP_VERSION = 'unknown';
```

- Ordre : `getVersion()` (Tauri, PC et iPhone, valeur de `tauri.conf.json` compilée dans le binaire), puis constante de build `__CT_APP_VERSION__` (définie par `vite.config.ts` depuis `tauri.conf.json` : le navigateur de dev et l'e2e `iphone` affichent la vraie version). Une valeur hors `^\d+\.\d+\.\d+$` ou égale à `0.0.0` est illisible. Les deux illisibles : `ok: false`, journal `app-version-unreadable` (code seul), « À propos » affiche « Version inconnue », la synchro continue.
- Utilisateurs : `bootstrap.ts` (PC et iPhone, plus de condition sur `desktop`), `AboutSection.tsx`, `dbDiagnostics.ts`, écran d'échec. `DesktopPlatform.getVersion` délègue au module.
- **Écart avec la fiche D1 (vérifié dans le code)** : `appVersion` ne peut pas être `null` dans l'état publié : `publishedStateFromJson` (`src/domain/sync/format.ts`) exige une chaîne conforme à `APP_VERSION_RE`, sinon l'état est `corrupt` chez l'autre appareil, y compris un PC déjà installé. Repli publié = `'unknown'` (conforme au format) ; `SyncDetailsVersion` le traduit en « version inconnue » (i18n). `createSyncService` : `appVersion` devient obligatoire, le repli `'0.0.0'` de `src/sync/service.ts` est supprimé.

**2. Numéro de build croissant** : `CFBundleVersion` = `version` de `tauri.conf.json` (comportement par défaut de Tauri 2.12.1, schéma de configuration vérifié : ni `bundle.iOS.bundleVersion`, ni `--build-number`, à garder ainsi). Nouveau `scripts/ios/check-source.mjs` (Node, sans dépendance), lancé par `build-ios.yml` en simulation sur branche (source publiée lue à l'URL publique, aucun secret) et avant le push sur tag. Refusé : `bundleIdentifier` ≠ `fr.circletasks.planner` ; ordre des `buildVersion` (comparaison numérique par composants) différent de l'ordre des `version`, ou égalité entre deux versions distinctes ; version publiée **inférieure** à la plus haute déjà présente (republier la même version remplace son entrée, `buildVersion` identique) ; `downloadURL` ≠ `ipaUrlFor(version)` ; `sha256` ou `size` absents ; champs d'app hérités différents de la première entrée. Avertissement (`::warning::`) : notes égales au repli.

**3. Notes de version** : `scripts/release/release-notes.mjs X.Y.Z [CHANGELOG.md]`, script commun PC et iPhone : section `## [X.Y.Z]` ou `## X.Y.Z` (même règle que l'`awk` actuel de `build-windows.yml`, qu'il remplace), sortie sur stdout, code 2 si absente. Sur tag (`vX.Y.Z` ou `ios-vX.Y.Z`) : section absente = **échec** du job ; sur branche : avertissement et repli `CircleTasks X.Y.Z`. Les notes vont dans `localizedDescription` (SideStore) et dans la page de la release. Français, une ligne par changement visible, aucune donnée personnelle.

**4. Pas de retour arrière** : aucune version plus ancienne n'est publiée (point 2). Si l'app trouve une base plus récente qu'elle, `migrate()` lève, **avant toute écriture** (ni sauvegarde, ni migration, ni `afterApply`) :

```ts
export class SchemaNewerThanApp extends MigrationError {
  override readonly name = 'SchemaNewerThanApp';
  constructor(readonly databaseVersion: number, readonly appSchemaVersion: number);
}
```

Écran : « Cette version de CircleTasks est plus ancienne que vos données. Installez la dernière version depuis SideStore. Vos données ne sont pas modifiées. » (variante PC : « … depuis Réglages > Rechercher une mise à jour »), actions « Copier le détail » et « Réessayer » ; pas de restauration. Le message brut `Base en version N, inconnue…` n'est plus affiché.

**5. Identifiant immuable** : `fr.circletasks.planner` dans `tauri.conf.json`, `build-ios.yml`, `source.template.json` et `VAULT_SERVICE` (`vault.rs`). Une mise à jour SideStore **avec le même Apple ID** garde le conteneur (base, `folder.json`, signet, `own.json`) et le Trousseau (`circletasks.sync.key.v1`) ; un autre Apple ID ou un autre identifiant = nouvelle app (états existants « Choisissez de nouveau le dossier » et « Clé introuvable », ADR 0011 §22 point 8 et §23). Test Node de cohérence : tout changement échoue avec « la mise à jour perdrait les données ».

**6. Premier lancement de N+1**

- Réglage `app.lastLaunchedVersion: string | null` (`src/domain/model/settings.ts`, `scope: 'local'`, jamais synchronisé). Règle pure `classifyLaunch(previous, current): 'first-install' | 'same' | 'updated' | 'downgraded' | 'unknown'` dans `src/domain/appUpdate.ts`. Écrit à la fin d'un `bootstrapApp` réussi seulement (jamais si la version est illisible).
- **Sauvegarde « Avant mise à jour »** = famille `pre-migration` existante (libellé `kindPreMigration`), faite seulement s'il y a des migrations en attente (sans migration, la base n'est pas touchée). Unique : une sauvegarde `…-vAAAA-to-vBBBB-…` avec `BBBB` = cible et `AAAA` ≤ version courante existe déjà → elle est réutilisée. Liste illisible : nouvelle sauvegarde (un doublon vaut mieux qu'aucune).

```ts
export interface MigrationBackup {
  backup(request: MigrationBackupRequest): Promise<{ readonly name: string }>; // nom renvoyé par Rust (déjà le cas), jamais un chemin
  findPrevious?(target: { readonly fromVersion: number; readonly toVersion: number }): Promise<{ readonly name: string } | null>;
}
```

- **Mise à jour interrompue** : chaque migration est transactionnelle ; au démarrage suivant, `migrate()` reprend à la première non appliquée, la sauvegarde est réutilisée, et `app.lastLaunchedVersion` n'ayant pas été écrit, le lancement compte encore comme `updated`.
- **`updated`** : journal `app-updated {de} {vers}` (numéros seuls) ; le premier passage des rappels est demandé avec le déclencheur **`'update'`** au lieu de `'open'` (`startNotifications.ts`) : même passage complet (plan recalculé, réaffirmation par le nouveau processus de chaque élément conservé, différence avec `get_pending` : ADR 0012 N1.2, rien n'est annulé puis reposé sans raison), ajouté à `SIGNING_TRIGGERS` (identifiant 2 reposé). Aucune boîte « bienvenue ». **`downgraded`** : journal `app-downgraded`, aucune migration inverse. Une restauration P-04 remet l'ancienne valeur : le lancement suivant compte comme `updated` (une replanification de plus, sans effet néfaste).

**7. Échec de migration après la mise à jour** : `DbFailure` (`appStore.ts`) gagne des champs facultatifs, remplis par `bootstrapDatabase` (nouveau crochet `onSchemaRead({ current, known })` de `MigrateOptions`, appelé après la lecture de `schema_migrations`) :

```ts
readonly kind?: 'schema-newer' | 'migration' | 'backup' | 'other';
readonly appVersion?: string | null;      // appVersion.ts
readonly schemaVersion?: number | null;   // dernière migration appliquée à la base au moment de l'échec
readonly appSchemaVersion?: number;       // dernière migration connue du code
readonly updateBackup?: { readonly name: string } | null; // sauvegarde « Avant mise à jour » de ce démarrage (créée ou réutilisée)
```

Écran : étape « migration {n} », nom de l'erreur, version de l'app, versions de schéma, chemin de la base ; « Vos données sont intactes. Ne supprimez pas CircleTasks. Envoyez le détail pour obtenir un correctif. » ; actions « Réessayer », « Copier le détail » et **« Restaurer la sauvegarde d'avant la mise à jour »** si `updateBackup` existe et si le service de récupération est disponible. La base étant fermée à cet écran, `src/platform/backup` exporte `openStartupRecovery(runtime, os): BackupService | null` (même `createTauriBackup` que P-04 / P-04-iOS, adaptateur de base fermée : point de contrôle et fermeture sans effet). Confirmation, « Annuler » par défaut : « Vos données reviennent à leur état d'avant la mise à jour. Cette version retentera la mise à jour au prochain démarrage ; si l'erreur revient, installez la version corrigée. » Échec de restauration : raison P-04 affichée, l'écran reste. Journal `db: migration {n} impossible ({nom})`, sans contenu. Sauvegarde impossible : aucune migration, `dbBackupFailed` et « Réessayer » (D-03, inchangé, vérifié sur `ios`).

**Conséquences** : la sortie d'une migration fautive est toujours une IPA corrigée N+2, jamais une rétrogradation ; la restauration remet les données exactes d'avant la mise à jour, utile surtout quand une chaîne de migrations s'est arrêtée au milieu. Les migrations restent transactionnelles et additives (ADR 0002).

**Fichiers impactés** : `src/platform/appVersion.ts` (+ test), `src/vite-env.d.ts`, `vite.config.ts` (`define`), `src/platform/desktop/tauriDesktop.ts`, `src/platform/dbDiagnostics.ts`, `src/platform/backup/{index,recovery}.ts`, `src/platform/tauri/migrationBackup.ts`, `src/db/{migrator,migrationBackup}.ts`, `src/domain/appUpdate.ts`, `src/domain/model/settings.ts`, `src/sync/service.ts`, `src/features/app/{bootstrap.ts,appStore.ts,DbFailureDetails.tsx}`, `src/features/reminders/{replanNotifications,startNotifications,signingNotice}.ts`, `src/features/settings/AboutSection.tsx`, `src/features/sync/SyncDetailsVersion.tsx`, `src/i18n/{fr,en}*`, `scripts/ios/{check-source.mjs,ios.test.ts}`, `scripts/release/{release-notes.mjs,release.test.ts}`, `.github/workflows/{build-ios,build-windows}.yml`, `CHANGELOG.md`, `docs/install-iphone.md`. Inchangés : Rust, `src/sync/**` hors `service.ts`, `Info.ios.plist`, `plist-contract.json`.
