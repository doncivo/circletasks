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
| `src/platform/files/*` | platform | Contrat `FileService`, seules lignes qui importent `@tauri-apps/plugin-dialog` et `@tauri-apps/plugin-fs`. |
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
- Implémentations : Tauri PC (`createTauriFiles`, plugins chargés par import dynamique), navigateur de développement (téléchargement `<a download>`), mémoire (faux des tests), indisponible (iPhone).
- Sélection : `web` → navigateur ; `tauri` + `windows` → Tauri ; `tauri` + `ios` → indisponible, `canSave()` faux, le bouton « Exporter » n'est pas affiché.
- Crochet de test `globalThis.__ctFiles`, lu seulement sous `import.meta.env.DEV` (absent du build de production).
- `pickText` n'est pas implémenté côté Tauri (`unsupported`) : P-07 l'ajoutera avec `dialog:allow-open` et `fs:allow-read-text-file`, toujours sans périmètre statique (avenant à prévoir alors).

### Plugins Tauri et permissions

- Crates `tauri-plugin-dialog` 2 et `tauri-plugin-fs` 2 dans `[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`, initialisés dans `desktop::configure` (module `#[cfg(desktop)]`) : **absents du build iOS**, comme les plugins de l'ADR 0006.
- Capability `src-tauri/capabilities/export.json` (fenêtre `main`, Windows seulement) : `dialog:allow-save`, `fs:allow-write-file`, `fs:allow-remove` (nettoyage d'un fichier partiel), `opener:allow-reveal-item-in-dir`. Aucune permission `:default`, aucun périmètre statique : le plugin dialog ajoute au périmètre du plugin fs le seul chemin choisi dans « Enregistrer sous ». Garde-fou : `cargo test` `export_capability_has_no_static_file_scope` (aucune lecture, aucun `scope`, aucun `fs:default`).
- Aucune commande Rust applicative ajoutée.

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
