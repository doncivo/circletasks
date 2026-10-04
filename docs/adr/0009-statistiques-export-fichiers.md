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
- `pickText` n'est pas implémenté côté Tauri (`unsupported`) : P-07 l'ajoutera de la même façon, par une commande Rust qui lit le seul fichier choisi (avenant à prévoir alors).

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

- P-04 et P-07 réutilisent `container.files` ; aucune feature n'importe un plugin de fichiers.
- Sur iPhone, l'export reste masqué jusqu'à l'ordre 5 : le plugin Fichiers (Swift, `UIDocumentPickerViewController`) implémentera le même contrat `FileService` dans `src/platform/files`, sans changer les features. Les crates dialog / fs ne seront pas activées sur iOS sans nouvel avenant.
- Taille de l'installeur PC : les crates dialog et fs s'ajoutent à la mesure de l'ADR 0006 (2,70 Mo) ; à remesurer au prochain `tauri build` (budget 15 Mo, PRD 8).
- Le tableau des dépendances de l'ADR 0001 et la section « Dépendances ajoutées » de l'ADR 0006 renvoient à cet ADR.

## Avenant P-04 — sauvegarde quotidienne et restauration (2026-10-05)

Nouvelle architecture : le module `src-tauri/src/backup.rs` de D-03 (dossier `backups/`, `VACUUM INTO` vers un `.tmp`, `sync_all`, renommage) est étendu, pas dupliqué ; `create_migration_backup` passe par la même fonction de copie `copy_database`. Aucune nouvelle crate.

| Élément | Décision |
| --- | --- |
| Familles de fichiers (purge séparée) | `circletasks-pre-migration-…` (5), `circletasks-daily-AAAAMMJJ.db` (14), `circletasks-pre-restore-AAAAMMJJTHHMMSSZ.db` (3). `parse_backup_name` reconnaît la forme exacte de chaque nom (aucun séparateur, `:`, `..`) ; tout autre fichier du dossier est ignoré et jamais supprimé |
| Commandes Rust (cinq, `capabilities/backups.json`) | `daily_backup(day, replace)` (hors du fil de l'interface, attente de verrou 2 s) ; `list_backups` (nom, famille, taille, heure du fichier, tâches, version de schéma, et le dossier) ; `check_backup(name, appSchemaVersion)` ; `restore_backup(name, stamp, appSchemaVersion)` ; `reveal_backups_folder` (aucun paramètre, `open_path` du dossier, PC seulement). La WebView ne transmet qu'un NOM pris dans la liste, jamais un chemin : pas de boîte « Ouvrir » pour la restauration |
| Capability `backups.json` | Fenêtre `main`, Windows seulement, uniquement les cinq permissions `allow-…` ; aucune permission fs, dialog ni opener. Les capabilities `default`, `capture` et `focus` ne portent aucune de ces commandes (test `config.rs`). iPhone : non ouvertes à l'ordre 3 (voir ci-dessous) |
| Restauration sûre | (1) nom valide et fichier présent ; (2) `PRAGMA integrity_check` = ok, table `schema_migrations` non vide, version <= celle de l'app (`newer-schema`, `corrupt`) ; (3) copie de sécurité de l'état actuel ; (4) fichier choisi recopié par `VACUUM INTO` à côté de la base (`circletasks.db.restoring`) et revérifié ; (5) `circletasks.db`, `-wal`, `-shm` renommés en `.restore-old`, puis le fichier préparé prend la place ; au moindre échec les renommages sont inversés (l'ancien `-wal` revient avec l'ancienne base) et le fichier préparé est supprimé ; `rollback-failed` seulement si le retour arrière lui-même échoue. Les anciens fichiers ne sont supprimés qu'après le succès |
| Côté TypeScript | `src/platform/backup` : contrat `BackupService` (`available`, `list`, `createDaily`, `restore`, `restart`, `reveal?`), implémentations Tauri (commandes Rust), mémoire (navigateur de développement et tests, `globalThis.__ctBackups` en DEV pour les e2e) et indisponible (iPhone). Fourni par `container.backups`. Ordre de la restauration : `check_backup` (base encore ouverte : un refus ne coûte rien), point de contrôle WAL, fermeture de la connexion unique, `restore_backup`, annonce « Restauration terminée, redémarrage », `relaunch` (permission `process:allow-restart` déjà accordée à la capability `desktop`) |
| Planificateur | `startBackupScheduler` (ouverture, `visibilitychange`, `focus`, minuteur d'une minute, rien fenêtre masquée) ; la règle « une par jour » est `isDailyBackupDue` (domaine, horloge injectable) |

Limites connues : une restauration depuis l'app ne peut pas annuler une opération déjà publiée dans les journaux de synchro (ordre 4, Y-02 et Y-09 des dettes) ; un lecteur ou une sauvegarde sur disque réseau n'est pas concerné (le dossier est celui de l'app) ; sous Windows, si un antivirus garde le fichier ouvert, le renommage échoue et le retour arrière rétablit l'ancienne base (message « Redémarrez CircleTasks »).

iPhone : le code Rust de copie est partagé, mais les cinq commandes ne sont inscrites que dans le gestionnaire PC et la capability est limitée à Windows (consigne du lot P) ; sur iPhone `container.backups` est indisponible et la ligne « Sauvegarde automatique » n'est pas affichée. L'ouverture de ces commandes à iOS (capability `platforms: ["iOS"]` + gestionnaire mobile + `relaunch` impossible sur iOS) est à décider avec l'ordre 5.
