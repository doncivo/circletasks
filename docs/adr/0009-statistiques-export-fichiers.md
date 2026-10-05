# ADR 0009 — Statistiques, graphique Recharts et accès aux fichiers (export)

- Statut : accepté
- Date : 2026-10-04
- Stories : H-01, H-02, H-03 (M11), ES-08 ; prépare P-04 (copie de sauvegarde) et P-07 (import CSV)

## Contexte

Le rapport du mois (H-01) agrège tâches, routines, sessions Focus et objectifs, filtrés par espace et par projet (ES-08), sans lire toutes les lignes en mémoire. H-02 demande un graphique en barres réalisé avec Recharts (critère 7). H-03 exporte l'historique (CSV, JSON) et le rapport (PDF, image) : c'est le premier accès de l'app à un fichier choisi par l'utilisateur, alors que le PRD exige que l'app n'accède qu'au fichier choisi (H-03 critère 7) et que le code partagé tourne sur Windows et sur iPhone (ADR 0001). Sur iPhone, l'enregistrement de fichiers passe par le plugin Fichiers de l'ordre 5 ; il n'existe pas encore.

## Décision

### Couches

| Brique | Couche | Rôle |
| --- | --- | --- |
| `src/domain/monthReport.ts` | domain | Bornes du mois (pas de date future), semaines ISO, pourcentages, tuiles, mois vide. Pur. |
| `src/domain/historyExport.ts` | domain | Lignes CSV (échappement, protection contre l'injection de formule), JSON (`schema_version` du format de fichier = 1, distincte du schéma SQLite), noms de fichiers. Pur. |
| `src/domain/reportLayout.ts` | domain | Mise en page du rapport exporté en liste d'opérations de dessin (grille de 880 unités), sans canvas ni DOM ; textes reçus en paramètre (`ReportTexts`, fournis par i18n via la feature). |
| `src/domain/pdfDocument.ts` | domain | PDF minimal A4 d'une page contenant un JPEG. Pur (seul `TextEncoder`, disponible en Node, WebView2 et WKWebView). |
| `src/db/repositories/statsRepository.ts` (+ `sql/`) | db | Contrat `StatsRepository` : agrégats SQL (`COUNT` / `GROUP BY`), `oldestActivity`, lecture paginée par curseur pour l'export (`listTasksForExport`, pages de 500). Aucune règle métier. Exposé par `Repositories.stats`. |
| `src/platform/files/*` | platform | Contrat `FileService` ; seul code qui appelle les commandes Rust d'export (`export_save_file`, `reveal_exported_file`). |
| `src/features/stats/*` | features | Écran `ReportScreen`, graphique, rendu canvas (`reportImage.ts`), boîte d'export ; reçoit `container.files`, jamais Tauri. |

Les en-têtes et valeurs du CSV (`titre`, `statut`, « fait » / « à faire »…) sont un **format de fichier stable** (relu par P-07), pas des textes d'interface : ils restent dans `historyExport.ts` et ne passent pas par `src/i18n` (exception assumée à l'ADR 0003, limitée au contenu des fichiers exportés).

### Contrat `FileService` (`src/platform/files/types.ts`)

```ts
interface SaveRequest { suggestedName: string; mime: string; data: Uint8Array }
interface SaveResult { saved: boolean; path?: string }            // saved: false = annulation, pas une erreur
type FileFailureReason = 'write-failed' | 'unavailable' | 'unsupported';
class FileExportError extends Error { reason: FileFailureReason } // aucun fichier partiel laissé
interface FileExporter { canSave(): boolean; save(r: SaveRequest): Promise<SaveResult>; reveal?(path: string): Promise<void> }
interface FilePicker { pickText(o: { accept: readonly string[] }): Promise<{ name: string; text: string } | null> }
interface FileService extends FileExporter, FilePicker {}
```

- Fourni par le conteneur : `AppContainer.files` (`openFileService(runtime, os)` au démarrage, `createUnavailableFiles()` par défaut en test).
- Implémentations : Tauri PC (`createTauriFiles`, commandes Rust d'export), navigateur de développement (téléchargement `<a download>`), mémoire (faux des tests), indisponible (iPhone).
- Sélection : `web` → navigateur ; `tauri` + `windows` → Tauri ; `tauri` + `ios` → indisponible, `canSave()` faux, le bouton « Exporter » n'est pas affiché.
- Crochet de test `globalThis.__ctFiles`, lu seulement sous `import.meta.env.DEV` (absent du build de production).
- `pickText` n'était pas implémenté côté Tauri (`unsupported`) : P-07 l'a ajouté de la même façon, par une commande Rust qui lit le seul fichier choisi (voir l'avenant P-07 plus bas).

### Plugins Tauri et permissions (révisé après revue et audit, 2026-10-04)

- Crate `tauri-plugin-dialog` 2 seulement, dans `[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`, initialisée dans `desktop::configure` (module `#[cfg(desktop)]`) : **absente du build iOS**. Elle n'est appelée que depuis Rust ; aucune permission `dialog:` n'est accordée à la WebView. `tauri-plugin-fs` et les paquets npm `@tauri-apps/plugin-dialog` / `plugin-fs` ne sont pas utilisés.
- Deux commandes Rust (`src-tauri/src/export.rs`) :
  - `export_save_file` : corps plafonné à 64 Mio (vérifié avant toute copie, même plafond côté TS) ; nom suggéré en en-tête base64 (1 024 caractères au plus, réduit à un nom simple de 200 caractères, noms réservés Windows préfixés) ; boîte « Enregistrer sous » modale ouverte côté Rust ; chemin accepté seulement avec une lettre de lecteur (`Prefix::Disk` / `VerbatimDisk`) ; écriture atomique hors du runtime async (temporaire `.<nom>.ct-partial` dans le même dossier, `sync_all`, renommage : aucun fichier partiel, fichier existant intact en cas d'échec) ; dernier chemin mémorisé en état Tauri.
  - `reveal_exported_file` : sans paramètre, affiche dans l'Explorateur le seul dernier fichier écrit, après le même contrôle de chemin.
- Capability `src-tauri/capabilities/export.json` (fenêtre `main`, Windows seulement) : uniquement `allow-export-save-file` et `allow-reveal-exported-file`. Garde-fous `cargo test` : capability exacte, aucune permission `fs:`, `dialog:` ni `opener:` pour la capture et le Focus, aucun plugin fs.
- Limites connues (docs/dettes.md) : un lecteur réseau monté passe le contrôle de lettre de lecteur ; un arrêt brutal peut laisser un `.…ct-partial` caché, supprimé au prochain export du même nom.

### Recharts

- `recharts` 3.10 (MIT ; transitives `victory-vendor`/d3, `@reduxjs/toolkit`, `immer`, `reselect`, `decimal.js-light` sous MIT ou ISC), importé **uniquement** par `src/features/stats/CompletionChart.tsx`, chargé par `React.lazy` depuis `CompletionSection.tsx`.
- Mesure du 2026-10-04 (`vite build`) : bloc paresseux `CompletionChart-*.js` = 305 Ko minifié, **91 Ko gzip**, téléchargé seulement à l'ouverture du rapport. Aucun code Recharts dans les blocs de départ ; ceux-ci augmentent de 12 Ko gzip au total pour tout le lot H (écran, domaine, export), sans Recharts.
- Règle : tout autre import de `recharts` doit rester dans un module chargé paresseusement ; un import statique depuis un module du bloc de départ est refusé en revue.
- PDF et PNG sans dépendance : dessin canvas (`reportImage.ts`) et `pdfDocument.ts`.

## Conséquences

- P-07 réutilise `container.files` ; P-04 a son propre service (`container.backups`, avenant P-04) ; aucune feature n'importe un plugin de fichiers.
- Sur iPhone, l'export reste masqué jusqu'à l'ordre 5 : le plugin Fichiers (Swift, `UIDocumentPickerViewController`) implémentera le même contrat `FileService` dans `src/platform/files`, sans changer les features. Les crates dialog / fs ne seront pas activées sur iOS sans nouvel avenant.
- Taille de l'installeur PC : les crates dialog et fs s'ajoutent à la mesure de l'ADR 0006 (2,70 Mo) ; à remesurer au prochain `tauri build` (budget 15 Mo, PRD 8).
- Le tableau des dépendances de l'ADR 0001 et la section « Dépendances ajoutées » de l'ADR 0006 renvoient à cet ADR.

## Avenant P-04 — sauvegarde quotidienne et restauration (2026-10-05)

Nouvelle architecture : le module `src-tauri/src/backup.rs` de D-03 (dossier `backups/`, `VACUUM INTO` vers un `.tmp`, `sync_all`, renommage) est étendu, pas dupliqué ; `create_migration_backup` passe par la même fonction de copie `copy_database`. Aucune nouvelle crate.

| Élément | Décision |
| --- | --- |
| Familles de fichiers (purge séparée) | `circletasks-pre-migration-…` (5), `circletasks-daily-AAAAMMJJ.db` (14), `circletasks-pre-restore-AAAAMMJJTHHMMSSZ.db` (3). `parse_backup_name` reconnaît la forme exacte de chaque nom (aucun séparateur, `:`, `..`) ; tout autre fichier du dossier est ignoré et jamais supprimé |
| Commandes Rust (cinq, `capabilities/backups.json`) | `daily_backup(day, replace)` (hors du fil de l'interface, attente de verrou 2 s) ; `list_backups` (nom, famille, taille, heure du fichier, tâches, version de schéma, et le dossier) ; `check_backup(name)` ; `restore_backup(name, stamp)` (la version de schéma est la constante `APP_SCHEMA_VERSION` de Rust, comparée aux migrations par un test cargo) ; `reveal_backups_folder` (aucun paramètre, `open_path` du dossier, PC seulement). La WebView ne transmet qu'un NOM pris dans la liste, jamais un chemin : pas de boîte « Ouvrir » pour la restauration |
| Capability `backups.json` | Fenêtre `main`, Windows seulement, uniquement les cinq permissions `allow-…` ; aucune permission fs, dialog ni opener. Les capabilities `default`, `capture` et `focus` ne portent aucune de ces commandes (test `config.rs`). iPhone : non ouvertes à l'ordre 3 (voir ci-dessous) |
| Restauration sûre | (1) nom valide et fichier présent ; (2) `PRAGMA integrity_check` = ok, table `schema_migrations` non vide, version <= celle de l'app (`newer-schema`, `corrupt`) ; (3) copie de sécurité de l'état actuel ; (4) fichier choisi recopié par `VACUUM INTO` à côté de la base (`circletasks.db.restoring`) et revérifié ; (5) `circletasks.db`, `-wal`, `-shm` renommés en `.restore-old`, puis le fichier préparé prend la place ; au moindre échec les renommages sont inversés (l'ancien `-wal` revient avec l'ancienne base) et le fichier préparé est supprimé ; `rollback-failed` seulement si le retour arrière lui-même échoue. Les anciens fichiers ne sont supprimés qu'après le succès |
| Côté TypeScript | `src/platform/backup` : contrat `BackupService` (`available`, `list`, `createDaily`, `restore`, `restart`, `reveal?`), implémentations Tauri (commandes Rust), mémoire (navigateur de développement et tests, `globalThis.__ctBackups` en DEV pour les e2e) et indisponible (iPhone). Fourni par `container.backups`. Ordre de la restauration : `check_backup` (base encore ouverte : un refus ne coûte rien), point de contrôle WAL, fermeture de la connexion unique, `restore_backup`, annonce « Restauration terminée, redémarrage », `relaunch` (permission `process:allow-restart` déjà accordée à la capability `desktop`) |
| Planificateur | `startBackupScheduler` (ouverture, `visibilitychange`, `focus`, minuteur d'une minute, rien fenêtre masquée) ; la règle « une par jour » est `isDailyBackupDue` (domaine, horloge injectable) |

Durcissement après revue et audit (2026-10-05) :
- **Échange** : `-shm` et `-wal` sont renommés en `.restore-old` avant `circletasks.db`. Un `.restore-old` déjà présent n'est jamais écrasé : la restauration est refusée (`restore-pending`).
- **Récupération au démarrage** (`recover_interrupted_restore(db, backups)`, appelée dans le `setup` de `desktop.rs`, avant la première commande de la WebView, donc avant toute ouverture de la base) : décision fondée sur la présence de `circletasks.db.restore-old` (la base, déplacée en dernier), jamais de suppression d'une ancienne base :

  | `circletasks.db` | `.db.restore-old` | `-wal` / `-shm.restore-old` | action |
  | --- | --- | --- | --- |
  | présente | présent | indifférent | échange terminé : les `.restore-old` sont DÉPLACÉS dans `backups/` sous `circletasks-pre-restore-<horodatage>.db` (+ `-wal`, `-shm`), purgés ensuite par la rotation des 3 copies de sécurité |
  | présente | absent | présent | échange interrompu avant la base, ou retour arrière partiel (`rollback-failed`) : `-wal` et `-shm` remis en place |
  | absente | présent | indifférent | la base, le `-wal` et le `-shm` sont remis en place |

  Chaque `.restore-old` doit être un fichier ordinaire (`is_plain_file`) : sinon rien n'est touché (`unsafe-restore-file`). Toutes les cibles sont vérifiées avant le premier déplacement et une cible occupée n'est jamais écrasée (`recovery-conflict`). Un `.restoring` orphelin est une copie préparée d'une sauvegarde qui existe toujours : supprimé s'il est ordinaire.
- **Échec de récupération** : les erreurs de renommage sont propagées (`Result`). Voie retenue, la plus simple et la plus robuste avec Tauri 2 : QUITTER. `setup` renvoie une erreur, `Builder::run` échoue avant l'affichage de la fenêtre et avant tout appel de la WebView au plugin SQL (qui n'ouvre le fichier qu'à la première commande) : aucune base n'est ouverte ni créée. Sous Windows une boîte système bloquante (`MessageBoxW`, « Restauration interrompue : redémarrez CircleTasks… », même début que `backup.recoveryFailed`) précède la sortie ; seul le code d'erreur est journalisé, sans chemin ; les fichiers `.restore-old` restent intacts. Limite : cette garantie dépend de l'ordre `setup` puis première IPC de Tauri (docs/dettes.md : option, faire la récupération avant `Builder::run`).
- **Base piégée** : fichiers de sauvegarde ouverts avec `trusted_schema = OFF` ; `check_backup_file` compare chaque déclencheur (type, nom, table, SQL aux espaces compactés) à `REFERENCE_TRIGGERS` (`src-tauri/src/backup_triggers.rs`, 18 définitions identiques à celles des migrations, vérifiées par `triggers.test.ts`) et refuse toute vue, tout déclencheur inconnu ou homonyme au corps modifié ; le compteur de tâches et la version de schéma exigent de vraies tables. Après vérification, `reset_triggers` supprime tous les déclencheurs du fichier préparé et recrée ceux de la référence (pour les tables présentes, seulement si l'index de recherche existe) : fait sur le fichier PRÉPARÉ, avant l'échange, pour que la base mise en place n'ait que des déclencheurs de l'app et qu'un échec ne laisse aucun état à moitié restauré.
- **Fichiers** : `symlink_metadata`, liens symboliques et points d'analyse refusés (`is_plain_file`) ; base à vérifier ou à restaurer plafonnée à 512 Mo ; la purge supprime aussi le `-shm`.
- **Dossier et nom** : `list_backups` et `check_backup` refusent un dossier `backups/` qui est un lien ou une jonction ; `backup_database_before_migration` ne renvoie que le NOM du fichier créé.
- **WebView** : `list_backups` renvoie le libellé `%APPDATA%\<identifiant>\backups`, jamais le chemin absolu ; les messages `no-database` n'en contiennent plus ; la version de schéma n'est plus un paramètre.
- **Relance** : un seul point, `src/platform/relaunch.ts` (`relaunchApp`), utilisé par la mise à jour (D-03) et par la restauration.
- **Contrat `FileService`** : le type d'erreur s'appelle toujours `FileExportError` (nom hérité de H-03) bien qu'il serve aussi à la lecture (`too-large`, `unreadable`) ; renommage en `FileError` reporté (docs/dettes.md).

Limites connues : une restauration depuis l'app ne peut pas annuler une opération déjà publiée dans les journaux de synchro (ordre 4, Y-02 et Y-09 ; règles imposées à la synchro : ADR 0010) ; un lecteur ou une sauvegarde sur disque réseau n'est pas concerné (le dossier est celui de l'app) ; sous Windows, si un antivirus garde le fichier ouvert, le renommage échoue et le retour arrière rétablit l'ancienne base (message « Redémarrez CircleTasks »).

iPhone (P-04) : le code Rust de copie est partagé, mais les cinq commandes ne sont inscrites que dans le gestionnaire PC et la capability est limitée à Windows (consigne du lot P) ; sur iPhone `container.backups` est indisponible et la ligne « Sauvegarde automatique » n'est pas affichée. L'ouverture de ces commandes à iOS (capability `platforms: ["iOS"]` + gestionnaire mobile + `relaunch` impossible sur iOS) est à décider avec l'ordre 5.

## Avenant P-07 — import CSV, lecture du fichier choisi (2026-10-05)

`FilePicker.pickText` (contrat de l'ADR, jusqu'ici `unsupported` côté Tauri) est implémenté. Nouveau module `src-tauri/src/import.rs` et nouvelle capability dédiée `capabilities/import.json` (fenêtre `main`, Windows seulement, **une seule** permission : `allow-import-open-file`).

| Élément | Décision |
| --- | --- |
| Commande Rust | `import_open_file` (sans paramètre) : ouvre la boîte « Ouvrir » modale de la fenêtre principale (filtre csv / txt / tsv) via la crate `tauri-plugin-dialog` déjà présente (initialisée côté Rust seulement, aucune permission `dialog:` pour la WebView) ; `None` si l'utilisateur annule |
| Contrôles de lecture | chemin à lettre de lecteur seulement (`is_local_disk_path` de `export.rs`) ; extension csv / txt / tsv (insensible à la casse) ; fichier ouvert puis contrôlé SUR LE DESCRIPTEUR (`metadata().is_file()` : ni dossier, ni périphérique, ni tube) ; taille annoncée <= 2 Mo ; lecture bornée à 2 Mo + 1 octet (un fichier qui grossit pendant la lecture est refusé). Codes d'erreur : `not-local`, `bad-type`, `not-a-file`, `too-large`, `unreadable` |
| Retour | `{ name, data }` : nom sans dossier, octets en base64 (2 Mo au plus, soit 2,8 Mo de JSON) ; aucun chemin n'est renvoyé à la WebView |
| Côté TypeScript | `createTauriFiles().pickText` décode les octets par `decodeTextBytes` (`domain/textEncoding.ts`, pur) : BOM UTF-16, UTF-8 avec ou sans BOM, repli Windows-1252 ; `maxBytes` (défaut 2 Mo, passé par la feature) ne fait que réduire la limite fixe de Rust ; `FileExportError('too-large' \| 'unreadable')`. `FileFailureReason` reçoit ces deux raisons |
| iPhone installé | `openFileService('tauri', 'ios')` garde `canSave() = false` (pas d'export avant l'ordre 5) mais utilise le sélecteur de fichiers du système (`<input type="file">`, `pickTextFromInput`, plafond de 2 Mo vérifié avant lecture) pour `pickText` : le critère 13 de P-07 ne dépend pas du plugin Fichiers |
| Tests | `tests/desktop/import.rs` (plafond, types, dossiers, chemins réseau et relatifs), `config.rs` (capability exacte, absente des autres fenêtres), `files.test.ts` |
