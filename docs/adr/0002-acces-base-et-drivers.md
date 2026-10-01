# ADR 0002 — Accès à la base et drivers SQLite

- Statut : accepté
- Date : 2026-10-01
- Tâche : PREP-02 (ordre 0)

## Contexte

L'app stocke tout dans SQLite via tauri-plugin-sql (PC et iPhone, PRD 7). Mais les repositories et les migrations doivent aussi tourner :

- dans Vitest, sous Node, pour tester règles et requêtes sans lancer Tauri ;
- dans un navigateur ordinaire (`npm run dev`, Playwright), où l'IPC Tauri n'existe pas.

Contraintes : M14 (recherche) exigera FTS5 avec `unicode61 remove_diacritics` (PRD 6) ; les migrations doivent être rejouables et testées sur la base de la version précédente, avec sauvegarde avant migration (PRD 7 et 8).

Le plugin Tauri SQL repose sur un pool de connexions sqlx : deux appels successifs depuis JS ne passent pas forcément par la même connexion si des requêtes s'intercalent, ce qui rend un `BEGIN` / `COMMIT` envoyé en plusieurs appels peu fiable.

## Décision

### Contrat unique : `SqlDriver` (`src/db/driver.ts`)

```ts
type SqlValue = string | number | null;
interface SqlExecutor {
  execute(sql: string, params?: readonly SqlValue[]): Promise<{ rowsAffected: number; lastInsertId: number | null }>;
  select<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
}
interface SqlDriver extends SqlExecutor {
  readonly kind: 'tauri-sqlite' | 'sqlite-wasm';
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

- Paramètres positionnels `?` uniquement. Pas de BLOB (l'IPC du plugin passe par JSON) : booléens en 0/1, objets en JSON texte, instants en ISO UTC, dates en `YYYY-MM-DD`.
- Erreurs normalisées en `DbError` avec `code` : `constraint`, `busy`, `syntax`, `transaction-wait-timeout`, `closed`, `unknown`.
- `createSerializedDriver` (`src/db/serializedDriver.ts`) enveloppe toute connexion brute : file d'attente unique (une requête à la fois), transaction par `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`, garde contre l'usage d'une transaction terminée. Avec des appels strictement séquentiels, sqlx réutilise une seule connexion du pool : les transactions deviennent fiables.
- À l'intérieur de `transaction(fn)`, toutes les requêtes passent par `tx`. Les appels directs au driver émis pendant une transaction (lectures de rendu, autres stores) sont mis en file et attendent leur tour, comme les autres. S'ils attendent plus de `transactionWaitTimeoutMs` (10 000 ms par défaut, option de `createSerializedDriver` et des deux drivers, réduite dans les tests), ils sont rejetés par `DbError('transaction-wait-timeout')`, dont le message désigne la cause probable : un appel réentrant au driver (ou une transaction imbriquée) depuis `fn`, qui sans ce délai bloquerait la file indéfiniment. La transaction concernée échoue alors et est annulée (ROLLBACK). Une transaction légitime de plus de 10 s ferait aussi échouer les appels en attente : les transactions doivent rester courtes. Un handle `tx` réutilisé après la fin de sa transaction est refusé par `DbError('closed')`.

### Deux implémentations

| Driver | Où | Fichier |
| --- | --- | --- |
| `tauri-sqlite` | App Tauri (Windows, iOS) : `sqlite:circletasks.db` dans le dossier de configuration de l'app, `PRAGMA foreign_keys = ON`, `journal_mode = WAL` | `src/platform/tauri/sqlDriver.ts` |
| `sqlite-wasm` | Vitest (Node), navigateur de dev, Playwright : base en mémoire, `foreign_keys = ON` | `src/db/drivers/sqliteWasm.ts` |

**Driver de dev retenu : `@sqlite.org/sqlite-wasm`** (build officiel de SQLite 3.53 en WebAssembly, Apache-2.0). Il inclut FTS5 et JSON, fonctionne sous Node 22+ (en mémoire) et dans le navigateur sur le fil principal, sans en-têtes COOP/COEP. Vérifié : table FTS5 avec `remove_diacritics 2`, « reunion » trouve « Réunion ».

`sql.js` a été écarté : sa build npm (1.14) n'inclut pas FTS5 (« no such module: fts5 »), bloquant pour M14.

Côté production, le SQLite embarqué par sqlx (`libsqlite3-sys`, feature `bundled`) est compilé avec `SQLITE_ENABLE_FTS5` et `SQLITE_ENABLE_JSON1` : FTS5 est disponible sur PC et iPhone.

### Sélection par `src/platform/database.ts`

`openDatabase()` choisit le driver selon `detectRuntime()` (`isTauri()` de `@tauri-apps/api`). Les deux drivers sont chargés par import dynamique. Dans un build Tauri (`TAURI_ENV_PLATFORM` défini par la CLI), la branche Wasm est du code mort : vérifié, le `.wasm` (870 Ko) n'apparaît pas dans `dist/`.

### Migrations maison (`src/db/migrator.ts`)

- Table `schema_migrations (version INTEGER PRIMARY KEY, name, checksum, applied_at)`.
- Une migration = un fichier `src/db/migrations/NNNN_titre.ts` exportant `{ version, name, statements }`, enregistré à la fin de `src/db/migrations/index.ts`. Une instruction SQL par élément de `statements`, sans paramètre.
- Chaque migration s'exécute dans sa propre transaction (tout ou rien) ; `applied_at` vient de la `Clock` injectée.
- Rejouable : un second `migrate()` n'applique rien.
- Somme de contrôle FNV-1a : une migration modifiée après application bloque le démarrage (on corrige par une nouvelle migration, jamais en réécrivant l'ancienne).
- Une base dont la version est inconnue du code (app plus ancienne que la base) bloque aussi le démarrage.
- `beforeApply(pending)` est appelé une fois avant toute migration en attente : point d'accroche de la sauvegarde automatique.
- Les migrations intégrées à tauri-plugin-sql (côté Rust) ne sont pas utilisées : une seule mécanique, testée sous Vitest avec le driver Wasm.

Aucune table métier n'est créée à ce stade ; le registre est vide. Les 18 tables du PRD 6 arriveront par l'agent data-model.

## Conséquences

- Les repositories et migrations se testent sous Vitest, sans Tauri, avec le vrai moteur SQLite et FTS5.
- Les features n'écrivent jamais de SQL : elles passent par `src/db/repositories` (règle ESLint sur les drivers, revue de code pour le reste).
- Écart de versions : SQLite 3.53 (Wasm) en dev, SQLite de `libsqlite3-sys` (3.46) en production. Ne pas utiliser de fonction SQL plus récente que la version de production.
- La base de dev du navigateur est en mémoire : elle est vide à chaque rechargement. Un jeu de données de démonstration (`tests/fixtures`) pourra être chargé au démarrage en dev si besoin.
- Toute requête est sérialisée : c'est sans conséquence pour un seul utilisateur et 5 000 tâches, mais une requête longue retarde les suivantes.

## Points ouverts

- Le comportement transactionnel du driver Tauri (une connexion réutilisée par sqlx) doit être vérifié dans l'app réelle par un test `tauri dev` puis sur iPhone (POC-01).
- Emplacement exact de la base : tauri-plugin-sql la place dans le dossier de configuration de l'app ; à confirmer pour la sauvegarde quotidienne (desktop-tauri).
- Projet Playwright « iphone » en Chromium émulé ; ajouter WebKit si un écart de rendu Safari apparaît.
