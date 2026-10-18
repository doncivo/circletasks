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
- Projet Playwright « iphone » en Chromium émulé ; ajouter WebKit si un écart de rendu Safari apparaît. **Avenant du 2026-10-09** : projet `iphone-webkit` ajouté (titre « Synchronisation » sur deux lignes sur l’iPhone en 0.2.3) : contrôles de mise en page seulement (`tests/e2e/IOS-titres.spec.ts`), build de production avec accroches de test (`CT_E2E_WEBKIT=1`), job `e2e-webkit` de la CI.

## Avenant D-03 (2026-10-02) : sauvegarde automatique avant migration

Critères D-03 8 et 9 ; PRD section 7. Remplit le point d'accroche `beforeApply`.

- **Déclenchement** : `migrate()` appelle `beforeApply(pending, { fromVersion })` une fois, avant la première migration en attente. `createBackupBeforeMigration` (src/db/migrationBackup.ts) ne sauvegarde que si `fromVersion >= 1` : base neuve ou déjà à jour = aucune sauvegarde.
- **Échec bloquant** : toute erreur de sauvegarde devient `MigrationBackupError` ; aucune migration n'est appliquée, la base est fermée, `dbStatus = 'error'` et `dbBackupFailed = true` : l'écran affiche `app.dbBackupError` (« … Vos données n'ont pas été modifiées … »).
- **Copie (Tauri)** : le front fait `PRAGMA wal_checkpoint(TRUNCATE)` sur l'unique connexion, (busy = 0 exigé), puis appelle la commande Rust `backup_database_before_migration` (src-tauri/src/backup.rs) qui fait `VACUUM INTO` (rusqlite, lecture seule) vers un `.tmp`, `sync_all`, puis renomme : jamais de sauvegarde partielle sous son nom final, pas de `-wal` à copier, `.tmp` orphelins supprimés au début de chaque sauvegarde. Base absente avec `fromVersion >= 1` : erreur `no-database` ; le front rejette aussi un résultat sans chemin.
- **Emplacement** : `<dossier de configuration de l'app>/backups/` (même dossier que la base, `%APPDATA%\fr.circletasks.planner` sous Windows, hors dossier d'installation, jamais touché par l'installeur). Ce dossier est aussi celui de P-04.
- **Nommage** : `circletasks-pre-migration-vAAAA-to-vBBBB-AAAAMMJJTHHMMSSZ.db` (versions de schéma avant et après, horodatage UTC fourni par la `Clock`). P-04 utilisera le préfixe `circletasks-daily-AAAAMMJJ.db` dans le même dossier et sa propre rétention (14 versions).
- **Nettoyage** : après une sauvegarde réussie, on garde les 5 dernières sauvegardes de migration (`KEEP_MIGRATION_BACKUPS`, tri par horodatage) ; seuls les fichiers du préfixe de migration sont supprimés, jamais les quotidiennes. Un échec de nettoyage ne fait pas échouer la sauvegarde.
- **Driver de dev (SQLite Wasm)** : sauvegarde sautée (base en mémoire, vide à chaque rechargement, rien à protéger). La copie réelle est couverte par `cargo test` (base WAL), l'orchestration par Vitest.
- **iPhone** : la commande est aussi enregistrée et autorisée (capability par défaut) ; même dossier de configuration de l'app.
- **Tests** : Vitest (orchestration, échec bloquant, bootstrap, rejeu 0001/0002/0003 -> 0004 sur base peuplée avec « copie » comparée) ; cargo test `tests/desktop/backup.rs` (WAL avec et sans checkpoint, atomicité, rétention 5, quotidiennes épargnées).
- **Reste pour Ali (D-03 critère 8, installation réelle)** : mettre à jour un build installé N vers N+1 avec migration et vérifier la présence d'un fichier dans `%APPDATA%\fr.circletasks.planner\backups\` et des données intactes.

## Avenant RC-01 (2026-10-04) : index de recherche

- `search_index` (FTS5) et `search_index_doc` (liaison élément → rowid) sont locaux : exclus des journaux de synchro, reconstruits sur chaque appareil (`SearchRepository.rebuild`, `isStale`).
- Mise à jour par déclencheurs SQL (migration 0011), donc aussi pour les écritures de la synchro ; suppression logique = retrait de l'index, restauration = retour.

## Renvoi I-06 (2026-10-09)

Base plus récente que l'app : erreur typée `SchemaNewerThanApp` (avant toute écriture) ; échec d'une migration après une mise à jour : sauvegarde « Avant mise à jour » unique (réutilisée à la reprise) et action « Restaurer la sauvegarde d'avant la mise à jour ». Détail : ADR 0007, avenant I-06 points 4, 6 et 7.

## Avenant SEC-01 (2026-10-18) : plugin SQL fermé (bloquant B7 de l'audit 1.0)

Constat : les permissions du plugin SQL sont par commande, sans portée sur les arguments ; une dépendance npm compromise ou une injection dans la WebView pouvait donc faire ouvrir ou créer un fichier n'importe où (`load` avec un chemin absolu ou `..`), attacher une autre base (`ATTACH`), copier la base (`VACUUM INTO`) ou changer des réglages dangereux (`PRAGMA writable_schema`). La défense est dans le code vendu (`src-tauri/vendor/tauri-plugin-sql/src/guard.rs`). Quatre couches :

- **URL** : `load` n'accepte que la chaîne exacte `sqlite:circletasks.db` (`validate_db_url`), contrôlée en premier dans `load` et dans `DbPool::connect`, avant toute lecture de chemin ou création de fichier. C'est le seul chemin du front (`src/platform/tauri/sqlDriver.ts`).
- **Limite** : `SQLITE_LIMIT_ATTACHED = 0` sur chaque connexion du pool (posée par `after_connect` de sqlx, après les pragmas `journal_mode = WAL` et `foreign_keys = ON` de `open_sqlite_pool`). Aucune base ne peut être attachée, ni par `ATTACH`, ni par `VACUUM INTO`, qui attache sa cible.
- **Autorisateur SQLite** (`sqlite3_set_authorizer`, `libsqlite3-sys` 0.30.1 déjà verrouillée, dépendance directe optionnelle du plugin, petit module `unsafe` commenté) : refuse `ATTACH`, `DETACH`, les fonctions `load_extension`, `fts3_tokenizer`, `readfile`, `writefile`, `edit`, les tables virtuelles hors `fts5` et tout `PRAGMA` hors liste blanche. C'est SQLite qui décide sur l'instruction analysée : aucun contournement par la forme du texte.
- **Filtre lexical `VACUUM`** : SQLite n'a aucun code d'autorisation pour `VACUUM` (33 codes, de `SQLITE_CREATE_INDEX` à `SQLITE_RECURSIVE`, vérifié sur sqlite.org/c3ref/c_alter_table.html), l'autorisateur ne le voit donc pas. `execute` et `select` refusent toute instruction contenant le mot hors commentaire, littéral et identifiant entre guillemets. Ceinture de plus : la couche « limite » bloque déjà `VACUUM INTO`.

Liste blanche de pragmas (tout le reste est refusé, y compris en lecture ; un pragma futur reste refusé tant qu'il n'est pas listé ici, avec une ligne d'ADR) : `foreign_keys` (lecture, `ON` ou `1`), `journal_mode` (lecture ou `WAL`), `wal_checkpoint` (tout argument), et deux lectures seules que SQLite émet lui-même : `data_version` (module `fts5`, migration 0011) et `quick_check` (`ALTER TABLE ... ADD COLUMN ... CHECK`, migration 0018). Les pragmas internes ont été trouvés par le rejeu des instructions du front sur un pool protégé (`tests/unit/sqlFrontReference.test.ts` génère `src-tauri/tests/fixtures/front-sql.json`, `guard_tests.rs` le rejoue) ; toute nouvelle migration qui en exigerait un autre fait échouer ce test.

Un refus est l'erreur `Error::Refused(code)` de code stable (`url`, `attach`, `vacuum`, `pragma`, `function`, `vtable`, `auth` pour un refus sans raison notée), jamais le texte SQL ni l'URL. Elle revient à la WebView sous la forme `sql-refused: <code>` : `Database.load` refusé tombe dans `DbStepError('load')` et l'écran d'échec de base existant, aucun texte nouveau. Chaque refus appelle le crochet `tauri_plugin_sql::set_refusal_hook`, câblé par `startup_gate::install_sql_refusal_hook` (début de `run()` et avant l'enregistrement tardif du plugin) sur `applog::write("sql-refused", code)` ; le débit du journal (ADR 0014) borne les rafales (10 lignes par minute et par code, puis résumé).

Hors du pool, donc non concernées : les sauvegardes, restaurations et vérifications de `backup.rs` (connexions `rusqlite` séparées, `VACUUM INTO` compris). La validation des chemins de leurs commandes n'est pas couverte par cet avenant. `capabilities/default.json` est inchangé (rien à retirer sans casser `execute`, pas de portée possible). Tests : `vendor/tauri-plugin-sql/src/guard_tests.rs` (24 tests du plugin), `tests/desktop/sql_closed.rs` (journal, câblage). Détail, rouge et vert : `docs/stories/SEC-01.md`.
