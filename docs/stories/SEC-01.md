# SEC-01 — Plugin SQL fermé : une seule base, ni ATTACH ni VACUUM INTO (bloquant B7)

Module : M16 Sécurité (technique, sans équivalent au PRD : écart à noter dans docs/decisions.md) · Ordre de construction : palier 1.0, **étape 5** (après T-TECH-01) · Agents : **desktop-tauri** (code Rust du plugin vendu, tests Rust) + **security-privacy** (revue de la liste des refus, audit de clôture) · Relecture : code-reviewer · Estimation : **5 h** (alerte à Ali et arrêt si le réel dépasse **7,5 h**, soit +50 %) · Statut : **développée le 2026-10-18 (3 commits de code), en attente de relecture, de la CI « suite verte » et de l’audit `security-privacy`**
Origine : `docs/audit-1.0.md`, ligne B7 (bloquant, « Sécurité »). Règles d'Ali (docs/decisions.md, 2026-10-17) : test rouge avant et vert après, jamais de test désactivé ni allongé, aucun échec silencieux.
Dépend de : rien d'ouvert. Touche : `src-tauri/vendor/tauri-plugin-sql/src` (`wrapper.rs`, `commands.rs`, `error.rs`, `Cargo.toml`), `src-tauri/Cargo.toml` et `Cargo.lock` si une dépendance directe est ajoutée, `src-tauri/src/startup_gate.rs` (câblage du journal), `src-tauri/tests`. **Ne touche pas le bundle de départ** (Rust), sauf si `src/db` change : la fiche l'interdit (voir critère 15).

## Contexte (constat vérifié sur `main` c01e961b, worktree `fiches-etapes-4-6`)

Le constat de l'audit tient. Une dépendance npm compromise dans le build du front, ou toute injection dans la WebView, peut appeler les commandes du plugin SQL avec des arguments libres.

1. **`load` accepte tout chemin.** `src-tauri/vendor/tauri-plugin-sql/src/commands.rs:12-29` : `load(db: String)` appelle `DbPool::connect(&db, &app)` sans contrôle. `wrapper.rs:78-107` : le schéma doit être `sqlite`, puis `path_mapper` (lignes 345-359) fait `app_path.push(<ce qui suit les deux-points>)`. Or `PathBuf::push` d'un chemin **absolu remplace** le dossier de base, et `..` en sort : `sqlite:C:\Users\...\Startup\x.hta` ou `sqlite:../../x.db` ouvrent (et **créent**, lignes 103-105 `Sqlite::create_database`) un fichier n'importe où. `?mode=...` et `:memory:` passent aussi.
2. **`execute` et `select` acceptent toute instruction.** `wrapper.rs:161` (`execute`) et `:229` (`select`) passent la chaîne telle quelle à sqlx. `ATTACH DATABASE '<chemin>' AS x` puis `CREATE TABLE x.t ...` écrit un fichier arbitraire ; `VACUUM INTO '<chemin>'` copie la base (clé de synchro et jetons compris, voir l'audit) vers un chemin choisi.
3. **La capacité ne limite rien.** `src-tauri/capabilities/default.json:7` : `sql:default` (close, load, select) et `sql:allow-execute`. Les permissions du plugin sont par commande, sans portée sur les arguments (**à vérifier par l'agent** dans le schéma des permissions généré ; si une portée existe, elle est notée en « Écarts » et la défense reste dans le code vendu). Le durcissement doit donc être **dans le code vendu**.
4. **Pourquoi les tests ne l'attrapaient pas.** `src-tauri/tests/desktop/config.rs` ne vérifie que les noms de permissions et l'ordre d'enregistrement du plugin (lignes 887-894) ; les tests du wrapper (`wrapper.rs:390-430`) n'ouvrent que des bases temporaires par `open_sqlite_pool` ; aucun test de `load` avec un chemin absolu ni de `ATTACH`. Les e2e tournent avec le pilote mémoire (sqlite-wasm), qui n'appelle jamais le plugin.
5. **Chemins légitimes côté front (vérifié).** Un seul : `sqlite:circletasks.db` (`src/platform/tauri/sqlDriver.ts:62` `TAURI_DB_URL`, utilisé par `openTauriSqlDriver`, appelé depuis `src/platform/database.ts:17` ; `src/platform/dbDiagnostics.ts:6` `DB_URL`, texte de diagnostic seulement). Aucune autre base : sauvegardes, restauration, vérification de version et reconstruction d'identité passent par **Rust avec `rusqlite` sur des connexions séparées** (`src-tauri/src/backup.rs` : `VACUUM INTO` ligne 327, ouvertures lignes 458-556, 717-1068), jamais par le plugin ni par le pool sqlx ; elles ne sont donc **pas concernées** par l'autorisation posée sur le pool.
6. **Instructions légitimes du front (vérifié par recherche dans `src`, hors tests).** Aucune occurrence de `ATTACH`, `DETACH`, `load_extension`, `readfile`, `writefile`, `fts3_tokenizer` ; `VACUUM` n'apparaît que dans des **commentaires** (`tauriBackup.ts:82,87`, `migrationBackup.ts:13`). Pragmas utilisés : `foreign_keys = ON` (`sqlDriver.ts:83`), `journal_mode = WAL` (`:86`) et lecture `journal_mode` (`src/features/app/bootstrap.ts:147`), `wal_checkpoint(TRUNCATE)` (`src/platform/backup/tauriBackup.ts:93`, `src/platform/tauri/migrationBackup.ts:23`). Les migrations (`src/db/migrations`) créent aussi une **table virtuelle `fts5`** (`0011_search_index.ts:76`) et des déclencheurs : à autoriser.

## Décisions retenues

- **D1. `load` : liste blanche d'une seule valeur.** `load` n'accepte que la chaîne **exacte** `sqlite:circletasks.db` (sensible à la casse, aucun suffixe, aucun paramètre `?`, aucun séparateur, aucun `..`, aucun chemin absolu, aucune forme `sqlite://`, `sqlite::memory:`, `file:`). Toute autre valeur est refusée **avant** toute création de dossier ou de fichier. La vérification est une fonction pure `validate_db_url(&str) -> Result<(), Error>` appelée en premier dans `load` (et par `DbPool::connect`, pour qu'aucun autre appelant ne la contourne).
- **D2. Deux protections sur la connexion SQLite, posées à l'ouverture du pool** (dans `open_sqlite_pool`, pour que les tests existants du pool les exercent) :
  1. `sqlite3_limit(db, SQLITE_LIMIT_ATTACHED, 0)` : aucune base attachée possible ;
  2. un **autorisateur** (`sqlite3_set_authorizer`) qui refuse : `SQLITE_ATTACH`, `SQLITE_DETACH` ; les fonctions `load_extension`, `fts3_tokenizer`, `readfile`, `writefile`, `edit` ; les tables virtuelles dont le module n'est pas `fts5` ; et tout `PRAGMA` hors **liste blanche** (D3).
  Mise en œuvre attendue : `SqlitePoolOptions::after_connect` de sqlx 0.8 puis `LockedSqliteHandle::as_raw_handle()` ; cela exige `libsqlite3-sys` en dépendance **directe** du plugin vendu à la version déjà verrouillée (**0.30.1**, `Cargo.lock`, la même que celle de sqlx-sqlite 0.8.6 et de rusqlite 0.32.1 : aucune nouvelle version téléchargée) et un petit bloc `unsafe` documenté. Si cette voie se révèle impossible, l'agent le consigne avant de choisir une autre.
- **D3. Pragmas : liste blanche, tout le reste refusé.** Autorisés : `foreign_keys` (lecture, ou valeur `ON`/`1`), `journal_mode` (lecture, ou valeur `WAL`), `wal_checkpoint` (tout argument). **Refusés par défaut**, dont (liste utilisée par les tests) : `writable_schema`, `trusted_schema`, `temp_store_directory`, `data_store_directory`, `locking_mode`, `synchronous`, `mmap_size`, `application_id`, `user_version` (écriture), `schema_version`, `query_only`, `ignore_check_constraints`, `recursive_triggers`, `secure_delete`, `soft_heap_limit`, `hard_heap_limit`, `threads`, `journal_mode = DELETE` (valeur autre que WAL), `foreign_keys = OFF`. La liste blanche est préférée à une liste noire : un pragma futur est refusé tant qu'il n'est pas listé.
- **D4. `VACUUM` : filtre lexical, car SQLite n'a pas de code d'autorisation pour `VACUUM`.** (Affirmation à **vérifier par l'agent** dans la documentation SQLite des codes d'action de l'autorisateur ; si un code existe, il remplace le filtre.) Avant l'envoi à sqlx, `execute` et `select` refusent toute chaîne dont l'analyse lexicale (commentaires `--` et `/* */`, littéraux `'...'`, identifiants `"..."`, `[...]` et `` `...` `` retirés ; casse ignorée) contient le mot `VACUUM`, **à n'importe quelle position** (donc aussi après un `;`). Le mot n'est utilisé par aucune instruction légitime du front (contexte 6). Le filtre n'est qu'une seconde ligne : la première reste D2.
- **D5. Un refus est une erreur explicite, journalisée, jamais silencieuse.** Nouvelle variante d'erreur du plugin (`error.rs`) portant un **code stable** (`url`, `attach`, `vacuum`, `pragma`, `function`, `vtable`) et jamais le texte SQL (il peut contenir des données). Elle revient à l'appelant JavaScript comme toute erreur du plugin ; côté front, `Database.load` refusé tombe déjà dans `DbStepError('load', …)` (`sqlDriver.ts:79-80`), donc dans l'écran d'échec de base existant (`DbFailureDetails`) : **aucun texte nouveau**. Côté Rust, chaque refus appelle un crochet enregistré par le programme principal (`startup_gate.rs`, là où le plugin est construit, lignes 80-83) qui écrit `applog::write("sql-refused", <code>)` (`src-tauri/src/applog.rs:568`, codes `&'static str`), borné pour ne pas inonder le journal si un appelant boucle. L'autorisateur ne peut renvoyer qu'un code de refus à SQLite : l'erreur SQLite qui en résulte (`not authorized`) est reconnue côté plugin et convertie en la même variante, avec le même journal.
- **D6. Pas de changement du front ni des permissions.** `capabilities/default.json` reste tel quel (rien à retirer sans casser `execute`) ; le test de `config.rs` sur les permissions passe sans modification.
- **D7. Avenant ADR : ADR 0002 (accès base et drivers)**, qui décrit déjà le plugin et le pool à une connexion (avenants D-03, RC-01 et renvoi I-06). Avenant « SEC-01 » : liste blanche d'URL, limite d'attachement, autorisateur, liste blanche de pragmas, filtre `VACUUM`, journal `sql-refused`. Plus une entrée `docs/decisions.md`. Le numéro d'avenant est libre au moment de l'écriture.

## Critères testables

Rouge avant : voir « Plan ». Tous les tests Rust ci-dessous sont dans le plugin vendu (`wrapper.rs` ou un module de tests voisin) ou dans `src-tauri/tests/desktop`, selon le modèle des tests existants (`tempdir_in(.../target)`, jamais d'écriture hors du dépôt).

### Refus de `load` (1 h)

1. **Étant donné** `validate_db_url`, **quand** on lui passe `sqlite:circletasks.db`, **alors** `Ok`.
2. **Étant donné** chacune de ces valeurs : `sqlite:C:\Users\x\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\x.db`, `sqlite:/tmp/x.db`, `sqlite:\\?\C:\x.db`, `sqlite:../x.db`, `sqlite:sub/../../x.db`, `sqlite:sub\circletasks.db`, `sqlite:CircleTasks.db`, `sqlite:circletasks.db?mode=ro`, `sqlite:circletasks.db-wal`, `sqlite::memory:`, `sqlite://circletasks.db`, `sqlite:file:circletasks.db`, `sqlite:` (vide), `sqlite:circletasks.db ` (espace final), `mysql://h/d`, `postgres://h/d`, `circletasks.db` (sans schéma), `` (vide), **quand** on appelle `validate_db_url`, **alors** chacune renvoie la variante de refus de code `url`.
3. **Étant donné** une application factice (`tauri::test`, si la fonctionnalité `test` n'est pas déjà activée en dépendance de développement, l'agent le signale) et un dossier de configuration de test, **quand** `load` reçoit un chemin absolu ou `..`, **alors** il renvoie l'erreur de refus **et aucun fichier ni dossier n'est créé** (assertion sur le contenu du dossier cible avant et après).

### `ATTACH`, `DETACH`, `VACUUM`, pragmas, fonctions (2 h)

4. **Étant donné** un pool ouvert par `open_sqlite_pool` sur une base temporaire, **quand** `execute` reçoit `ATTACH DATABASE '<chemin dans target/>' AS x`, **alors** le résultat est l'erreur de refus de code `attach` et **le fichier cible n'existe pas** ; idem pour `ATTACH '...' AS x` (sans `DATABASE`), pour `attach` en minuscules, pour une instruction précédée d'un commentaire `/* */`, de `--` + saut de ligne ou d'espaces, et pour `SELECT 1; ATTACH ...` (chaînage).
5. **Étant donné** le même pool, **quand** `select` reçoit un `ATTACH` (la commande `select` passe aussi par sqlx), **alors** même refus.
6. **Étant donné** le même pool, **quand** `execute` reçoit `DETACH DATABASE x`, **alors** refus de code `attach` (même famille) ; et la limite `SQLITE_LIMIT_ATTACHED` vaut **0** (lue par un appel direct de test, indépendamment de l'autorisateur : preuve que la limite est posée même si l'autorisateur est neutralisé).
7. **Étant donné** le même pool, **quand** `execute` ou `select` reçoit `VACUUM INTO '<chemin dans target/>'`, ou `vacuum into`, ou `/**/VACUUM/**/INTO`, ou `SELECT 1; VACUUM INTO '...'`, ou `VACUUM` seul, **alors** refus de code `vacuum` et le fichier cible n'existe pas. **Étant donné** une instruction légitime qui contient le mot dans un littéral (`SELECT 'vacuum'`) ou un commentaire, **alors** elle **passe** (le filtre lexical ne produit pas de faux refus).
8. **Étant donné** le même pool, **quand** on envoie chacun des pragmas refusés de D3 (`writable_schema = 1`, `trusted_schema = 1`, `journal_mode = DELETE`, `foreign_keys = OFF`, `temp_store_directory = '...'`, `user_version = 5`, `locking_mode = EXCLUSIVE`, etc.), **alors** refus de code `pragma` et l'état de la base est inchangé (relecture du pragma).
9. **Étant donné** le même pool, **quand** on envoie `SELECT load_extension('x')`, `SELECT fts3_tokenizer('x')`, `CREATE VIRTUAL TABLE t USING rtree(id)`, **alors** refus de code `function` ou `vtable`.

### Non-régression (1,5 h)

10. **Étant donné** le pool, **quand** on joue les instructions que le front émet réellement : `PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL` (le test existant attend `wal`, `wrapper.rs:406-407`), `PRAGMA journal_mode` (lecture), `PRAGMA wal_checkpoint(TRUNCATE)`, `BEGIN IMMEDIATE`, `INSERT`/`UPDATE`/`DELETE`/`SELECT` paramétrés, `COMMIT`, `ROLLBACK`, **alors** toutes réussissent.
11. **Étant donné** toutes les migrations de `src/db/migrations` (tables, index, déclencheurs, table virtuelle `fts5`), **quand** elles sont jouées par le pilote **sur un pool Rust avec l'autorisateur actif** (test d'intégration Rust qui rejoue le texte des instructions des migrations, extrait par un petit script de test ou un fichier de référence généré, **sans en dupliquer à la main**), **alors** aucune n'est refusée. Si l'extraction exige un outil Node, le test est une vérification Vitest qui lit les migrations et un test Rust qui lit le fichier produit ; l'agent consigne la voie retenue.
12. **Étant donné** les tests existants du wrapper (`pool_has_one_connection_in_wal_mode`, `sequential_transactions_never_lock_themselves`) et ceux de la sauvegarde, de la restauration et du démarrage (`src-tauri/tests/desktop`), **quand** on les lance, **alors** ils passent **sans modification de leurs attentes** ; en particulier `VACUUM INTO` de `backup.rs:327` continue de fonctionner (connexion `rusqlite` séparée, non concernée).
13. **Étant donné** `src-tauri/tests/desktop/config.rs`, **quand** on le lance, **alors** il passe sans modification (permissions et ordre d'enregistrement inchangés, D6).
14. **Étant donné** un refus, **quand** il se produit dans le programme complet (test d'intégration avec le crochet câblé dans `startup_gate.rs`), **alors** une ligne `sql-refused` avec le code est écrite dans le journal de l'application, **sans** texte SQL ni chemin ; 1 000 refus consécutifs ne produisent pas 1 000 lignes (borne documentée).
15. **Étant donné** la recherche de `ATTACH`, `DETACH`, `VACUUM` (hors commentaires), `load_extension` et `readfile` dans `src` et `tests` (hors fichiers de test des refus), **quand** on la relance à la clôture, **alors** elle ne trouve rien : le résultat est copié dans « Preuves ». Aucun fichier de `src/` n'est modifié par cette story ; si l'agent doit en toucher un, il le signale (le bundle de départ a une marge de 43 octets : mesure de `npm run test:bundle` avant et après, arrêt et remontée à Ali au moindre dépassement).
16. **Étant donné** les e2e `pc` et `iphone` (pilote mémoire), **quand** ils tournent en CI, **alors** ils sont inchangés et verts.

### Clôture (0,5 h)

17. **Alors** : audit `security-privacy` rendu à la clôture (liste des refus relue, contournements essayés, dépendance `libsqlite3-sys` et bloc `unsafe` relus) ; ADR 0002 (avenant), `docs/decisions.md`, `docs/journal.md`, `docs/backlog.md`, `docs/audit-1.0.md` (ligne B7 : état) à jour ; suite Rust complète verte en CI sur la branche (« suite verte ») ; `cargo clippy` et lint propres ; aucun test désactivé ni allongé.

## Hors de cette story

- La clé de signature hors du build front : CI-SEC-01 (audit 1.0, section 5 point 2).
- Toute restriction des autres plugins ou commandes (fichiers, shell, notifications) : non examinées ici.
- Un chiffrement de la base ou du coffre : hors périmètre.
- Une portée de permission sur le plugin SQL si l'amont en ajoutait une (suivi de version : note en « Écarts »).
- Toute fonction de la liste « Hors périmètre » du PRD (section 1).

## Plan par phases (ordre des sous-tâches)

1. **Rouge** (1 h) : sur le code de `main`, écrire les tests des critères 4 à 9 contre l'API existante (`open_sqlite_pool` + `DbPool::execute`/`select`) : ils échouent par **assertion** parce que le plugin accepte. Pour `load` (critères 1 à 3), `validate_db_url` n'existe pas : un **bouchon** `validate_db_url` qui accepte tout est ajouté dans le **même commit** que les tests, pour que l'échec soit une assertion et non une erreur de compilation. Commit des tests (et du bouchon) **seuls** ; messages d'échec copiés en « Preuves ». Aucun test de ce commit ne crée de fichier hors de `target/` : les chemins d'attaque pointent vers `target/`, et le test nettoie.
2. **`load`** (1 h) : `validate_db_url`, variante d'erreur, appel en tête de `load` et de `connect` (critères 1 à 3).
3. **Autorisateur, limite, filtre `VACUUM`** (1,5 h) : dépendance directe, `after_connect`, listes D2 et D3, filtre D4 (critères 4 à 9).
4. **Journal et non-régression** (1 h) : crochet et `sql-refused` (critère 14), critères 10 à 13, 15 et 16.
5. **Audit, documentation, qa-test, code-reviewer** (0,5 h) : critère 17.

Découpage : 1 + 1 + 1,5 + 1 + 0,5 = 5 h.

## Vérifications

- Local : seulement les tests du module : `cargo test -p tauri-plugin-sql` et les tests de `src-tauri` qui touchent le plugin, la sauvegarde et la restauration (noms précis notés en « Preuves »), plus `cargo clippy`. Suite complète en CI sur la branche (statut « suite verte »). Aucune commande iOS locale (pas de Mac) : le plugin SQL est le même sur l'iPhone, compilé par `.github/workflows/build-ios.yml` **une seule fois** pour le lot terminé.
- Aucun fichier écrit hors du dépôt ; aucun secret ; aucun texte SQL dans le journal.
- Règle d'Ali : arrêt et alerte si l'estimation dérape de plus de 50 % (au-delà de 7,5 h).
- Clôture refusée si un critère manque : le product-owner vérifie les 17 critères avant « fait ».

## Preuves

Branche `sec-01-plugin-sql-ferme`, depuis `main` 81e3a0ac. Aucun push, aucune PR.

| Élément | Valeur |
|---|---|
| Rouge avant : commit et message d'échec exact des critères 2, 3, 4, 5, 7, 8, 9 | Commit `e373bab7` (« tests rouges du plugin SQL fermé », bouchon `validate_db_url` qui accepte tout). `cargo test -p tauri-plugin-sql --features sqlite` : 10 échecs par assertion, 7 réussites (non-régression : critères 1, 3 légitime, 7 littéraux, 10). Messages exacts ci-dessous. |
| Vert après : commit | `ca304e1b` (URL, limite, autorisateur, filtre `VACUUM` : les 10 tests rouges passent, 22 tests du plugin verts), puis `7354e5ff` (journal `sql-refused`, rejeu des instructions du front, deux pragmas internes de SQLite), puis le commit de documentation. |
| Vérification : aucun code d'autorisation pour `VACUUM` dans la documentation SQLite | Vérifié le 2026-10-18 sur https://sqlite.org/c3ref/c_alter_table.html (« Authorizer Action Codes ») : la page liste 33 codes, de `SQLITE_CREATE_INDEX` (1) à `SQLITE_RECURSIVE` (33), dont `SQLITE_ATTACH` (24), `SQLITE_DETACH` (25), `SQLITE_PRAGMA` (19), `SQLITE_CREATE_VTABLE` (29), `SQLITE_FUNCTION` (31) ; le mot « vacuum » n'y figure pas (recherche par `curl` sur le texte de la page : 0 occurrence). Le filtre lexical (D4) est donc nécessaire. Constat en plus, prouvé par test : `VACUUM INTO` attache sa cible, donc la limite `SQLITE_LIMIT_ATTACHED = 0` le bloque déjà (`sec01_6_the_limit_alone_blocks_attach_and_vacuum_into` : autorisateur retiré et filtre contourné par un appel direct de sqlx). |
| Voie retenue pour poser l'autorisateur | `SqlitePoolOptions::after_connect` de sqlx 0.8.6, puis `LockedSqliteHandle::as_raw_handle()`, puis `sqlite3_limit` et `sqlite3_set_authorizer` de `libsqlite3-sys` 0.30.1 (dépendance directe optionnelle du plugin vendu, liée à la fonctionnalité `sqlite`, déjà verrouillée : `Cargo.lock` gagne une seule ligne, aucune nouvelle bibliothèque). Tout le `unsafe` est dans `vendor/tauri-plugin-sql/src/guard.rs` (fonction de rappel, limite, pose de l'autorisateur, appel depuis `after_connect`), chaque bloc commenté. Les pragmas de connexion de sqlx (`journal_mode = WAL`, `foreign_keys = ON`) sont posés avant l'autorisateur. |
| Voie retenue pour le critère 11 | Vitest génère, Rust rejoue : `tests/unit/sqlFrontReference.test.ts` enregistre toutes les instructions SQL (et paramètres) que `migrate()` envoie à un pilote réel (table de suivi, 19 migrations) dans `src-tauri/tests/fixtures/front-sql.json` (fichier généré ; le test Vitest échoue s'il est périmé ; régénération : `CT_UPDATE_SQL_REFERENCE=1`). `guard_tests.rs::sec01_11_every_statement_the_front_sends_passes_the_closed_plugin` les rejoue sur un pool à autorisateur actif. Le rejeu a trouvé deux pragmas internes de SQLite (Écarts, point 3). |
| Recherche du critère 15 | Faite le 2026-10-18 sur `src` et `tests` : `ATTACH`, `DETACH`, `VACUUM`, `load_extension`, `readfile`, `writefile`, `fts3_tokenizer` (mots entiers, casse ignorée). Aucune instruction SQL ; seulement `VACUUM` dans des commentaires (`src/platform/backup/tauriBackup.ts:82,87`, `src/platform/tauri/migrationBackup.ts:13`) et des homonymes sans rapport (`detach` / `attach` : liens de tâches Apple Rappels, `testInfo.attach` de Playwright, `GoalAttachSwitch`, `useFocusTrap`). Pragmas du front : `foreign_keys = ON`, `journal_mode` (lecture et `= WAL`), `wal_checkpoint(TRUNCATE)`, rien d'autre. Aucun fichier de `src/` modifié (bundle de départ inchangé ; `npm run test:bundle` non relancé). |
| Commandes locales du module (2026-10-18) | `cargo test -p tauri-plugin-sql --features sqlite --locked` : 24 tests et 1 doctest, tous verts. `cargo test --locked --features test-hooks --test desktop` (cible partagée) : 800 réussis, 0 échec, 2 ignorés (préexistants, par exemple `sync_crypto::print_rust_sealed`). `cargo clippy -p tauri-plugin-sql --features sqlite --all-targets --locked` et sans la fonctionnalité : aucun avertissement. `cargo clippy --locked --features test-hooks --all-targets` sur le programme : 8 à 9 avertissements, tous préexistants et hors des fichiers de la story (`src/backup.rs` ×7, `src/sync/mod.rs`, tests `export`, `sync_fixes`, `sync_qa_crypto`, `sync_fs_conformance`, `fake_bookmark`, `ocr_vision`, `applog`) : non corrigés ici, à traiter dans une story à part ; aucun dans `startup_gate.rs`, `lib.rs`, `sql_closed.rs` ni dans le plugin. `npx vitest run tests/unit/sqlFrontReference.test.ts` vert ; `npx eslint` du fichier et `npx tsc --noEmit` propres. |
| CI « suite verte » (branche, run) | À faire après le push d'Ali (aucun push fait). |
| Audit `security-privacy` (date, conclusion) | À rendre à la clôture (préparation : « Surfaces vérifiées » ci-dessous). |

### Messages d'échec exacts du commit rouge `e373bab7`

```
sec01_2 : validate_db_url("sqlite:C:\\Users\\x\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.db") : refus `url` attendu, mais le plugin a accepté
sec01_3 : connect_in("sqlite:C:\\...\\target\\db-load-xxxx\\escaped.db") : refus `url` attendu, mais le plugin a accepté
sec01_4 : execute (attach-database) : refus `attach` attendu, autre erreur obtenue : error returned from database: (code: 14) unable to open database: ...\stolen-attach-database.db
sec01_4 (fichier existant) : execute ATTACH d'un fichier existant : refus `attach` attendu, mais le plugin a accepté
sec01_5 : select (plain) : refus `attach` attendu, autre erreur obtenue : error returned from database: (code: 14) unable to open database: ...
sec01_6 : execute DETACH DATABASE x : refus `attach` attendu, autre erreur obtenue : error returned from database: (code: 1) no such database: x
sec01_6 : assertion `left == right` failed: SQLITE_LIMIT_ATTACHED doit valoir 0 / left: 10 / right: 0
sec01_7 : execute (vacuum-into) : refus `vacuum` attendu, mais le plugin a accepté
sec01_8 : execute "PRAGMA writable_schema = 1" : refus `pragma` attendu, mais le plugin a accepté
sec01_9 : select load_extension : refus `function` attendu, autre erreur obtenue : error returned from database: (code: 1) not authorized
```

Le critère 1, l'ouverture légitime du critère 3, l'absence de faux refus de `VACUUM` (critère 7, littéral) et la non-régression (critère 10 : instructions du front, table `fts5`) passent sur le commit rouge, comme attendu. Les tests du journal (critère 14) et du rejeu des migrations (critère 11) sont écrits avec le correctif : le crochet de journal n'existait pas, et le rejeu n'a de sens qu'avec l'autorisateur actif.

## Écarts

Hypothèses prises pour les « Questions à Ali » (recommandations du product-owner appliquées, à confirmer par Ali) : (1) dépendance directe `libsqlite3-sys` et bloc `unsafe` acceptés ; (2) liste blanche stricte de pragmas ; (3) aucun contrôle des chemins de `backup.rs` dans cette story ; (4) ordre du plan d'Ali gardé (étape 5).

1. **`ATTACH` d'un fichier absent échouait déjà.** Le constat de l'audit et de la fiche (« `ATTACH ... AS x` puis `CREATE TABLE x.t` écrit un fichier arbitraire ») est inexact tel quel : sqlx ouvre la base principale sans `SQLITE_OPEN_CREATE`, donc l'`ATTACH` d'un fichier absent répond « unable to open database ». Le danger réel est l'`ATTACH` d'un fichier SQLite **existant** (lecture et écriture d'une autre base) ; un test l'exerce (`sec01_4_attaching_an_existing_foreign_database_is_refused_and_not_written`), en plus des formes de la fiche. `VACUUM INTO` créait bien un fichier (rouge prouvé : « le plugin a accepté »). `load` créait bien des fichiers n'importe où (`Sqlite::create_database`).
2. **Code d'erreur de repli `auth`.** La fiche liste six codes ; un septième, `auth`, est renvoyé si SQLite répond « not authorized » sans qu'aucune raison n'ait été notée par l'autorisateur (ne devrait pas arriver). Il est journalisé comme les autres.
3. **Deux pragmas de plus dans la liste blanche, en lecture seule, trouvés par le rejeu des migrations (critère 11).** `data_version` (émis par le module `fts5` lui-même à la création de `search_index`, migration 0011) et `quick_check` (émis par SQLite pour `ALTER TABLE ... ADD COLUMN ... CHECK`, migration 0018, sous la forme `pragma_quick_check(table, main)`). Sans eux, l'ouverture de toute base neuve ou à migrer échouait avec `sql-refused: pragma`. La liste blanche passe de trois à cinq pragmas ; aucun n'écrit. À relire par `security-privacy`.
4. **Permissions Tauri sans portée (vérifié).** Les permissions du plugin (`vendor/tauri-plugin-sql/permissions`) sont par commande, « without any pre-configured scope » : aucune portée sur les arguments, la défense reste dans le code vendu. `capabilities/default.json` inchangé (D6).
5. **`DbPool::execute`, `select`, `close` et `LastInsertId` deviennent publics** (le test du journal vit dans `tests/desktop`, hors du crate du plugin). Aucune commande Tauri nouvelle.
6. **`DbPool::connect_in`** : `connect` est coupé en deux pour que le test du critère 3 fournisse un dossier de données dans `target/` sans `AppHandle` (un `mock_app` aurait créé un dossier dans le profil de l'utilisateur). Même comportement.
7. **Borne de 1 000 refus** : c'est celle du journal existant (10 lignes par minute et par couple portée / code, puis résumé `log` / `suppressed`), pas un nouveau mécanisme ; testée avec 1 001 refus.
8. **Visibilité d'un refus côté écran (règle « aucun échec silencieux »), vérifiée par lecture, sans changement de `src/`.** `Database.load` refusé tombe dans `DbStepError('load', erreur)` (`src/platform/tauri/sqlDriver.ts`), dont le message est le texte exact de l'erreur Tauri (`describeError`), donc `sql-refused: url` apparaît dans l'écran d'échec de base existant (`DbFailureDetails`). Un refus pendant une requête revient comme `DbError` par le pilote sérialisé, avec le même texte. Aucun test e2e ne l'exerce (pilote mémoire) : à voir à la séance finale si Ali le souhaite.
9. **Fichier de référence de 245 Ko** (`src-tauri/tests/fixtures/front-sql.json`) : il contient les jeux de données des migrations (jours fériés). Acceptable pour un fichier de test, à signaler si la taille du dépôt compte.
10. **Pas de `cargo clippy` dans `tests.yml`** : la commande est lancée en local (voir Preuves) ; à ajouter à la CI si Ali le souhaite (hors story).
11. **Temps** : environ 4 h de travail effectif sur 5 h estimées (alerte à 7 h 30 non atteinte). La compilation du programme complet (5 à 9 minutes par essai de `--test desktop`) a motivé le choix de placer le rejeu des migrations dans le crate du plugin (essai en une minute).

## Revue et audit

Audit `security-privacy` : approuvé (aucun contournement trouvé sur le vrai pool : `ATTACH` par URI, vfs, `:memory:`, temp ; `pragma_*` en sous-requête, `WITH`, `RETURNING`, vue ; commentaires et casse ; `VACUUM` dans un `WITH` ; fonctions absentes de la version embarquée ; chaque connexion protégée, reconnexion comprise). Revue de code : « à corriger », rien de bloquant. Hypothèses sur les « Questions à Ali » : confirmées. Chaque point ci-dessous est un commit.

| Point | Commit | Rouge / vert |
|---|---|---|
| I1 : le front émet-il un pragma ou une fonction refusés ? | `88fb11d8` | Test Vitest statique `tests/unit/sqlPragmaScan.test.ts` : parcourt `src/**` (hors tests et `src/i18n`, commentaires retirés), exige que tout `PRAGMA nom` et `pragma_nom` soit dans `PRAGMA_WHITELIST` **lue dans `guard.rs`** (liste unique, constante créée pour l'occasion), et qu'aucune fonction refusée ni `ATTACH` / `VACUUM` n'apparaisse dans du SQL. Rouge : avec `export const TMP_SEC01 = 'PRAGMA user_version';` ajouté temporairement dans `src/db/repositories/common.ts` (retiré), échec `AssertionError: pragma hors liste blanche du plugin SQL … expected [ Array(1) ] to deeply equal []` avec `src/db/repositories/common.ts : PRAGMA user_version`. Vert sur l'arbre propre (3 tests). ADR 0002 complété. Limite connue : la recherche statique ne voit pas un SQL construit à l'exécution. |
| I2 : fichier cité dans le test de référence | `43d1b06f` | `guard_tests.rs`, pas `sql_closed.rs`. |
| I3 : assertion toujours vraie | `3608a847` | `assert_eq!(attach_lines, 10)`, renvoi au test du débit d'`applog`. |
| M1 revue : panic dans le rappel FFI | `03498e7a` | `catch_unwind` (`AssertUnwindSafe`) ; un panic devient `SQLITE_DENY`. |
| M2 revue : `quick_check` | `f1002788` | Accepté seulement avec argument ; `("quick_check", None)` passe côté refus dans `sec01_8_pragma_white_list_cases`. |
| M3 revue : contrôle redondant de `connect` | `54c6a32f` | Retiré ; `load` et `connect_in` restent. |
| M4 revue : accents de `Cargo.toml` | `bef31638` | Corrigés. |
| M1 audit : objets de schéma persistants | `27ffc0e7` (rouge), `bbd98245` (vert) | Rouge : `CREATE TRIGGER load_extension : refus `function` attendu, mais le plugin a accepté` ; `DEFENSIVE doit valoir 1, TRUSTED_SCHEMA 0 / left: 0 / right: 1`. Vert : `harden` pose `SQLITE_DBCONFIG_DEFENSIVE = 1` et `SQLITE_DBCONFIG_TRUSTED_SCHEMA = 0` (exposés par `libsqlite3-sys`), et `check_statement` refuse à la **création** un déclencheur ou une vue qui contient `load_extension`, `fts3_tokenizer`, `readfile`, `writefile`, `edit(` ou un `pragma_<nom>` hors liste blanche (mots du langage SQL seulement). Constat avant correctif : le déclencheur était créé puis chaque écriture de la table refusée, récupérable par `DROP TRIGGER`. Le rejeu des instructions du front (fts5, déclencheurs, `ALTER TABLE`) passe avec le schéma non fiable. |
| M2 audit : instructions multiples | (documenté) | `execute` envoie le texte entier à sqlx, qui exécute les instructions une à une : `INSERT …; ATTACH …` exécute l'`INSERT` puis refuse l'`ATTACH`, sans retour arrière du premier. Le front n'envoie jamais d'instructions multiples hors migrations (une instruction par appel, `statements` du migrateur), et une transaction du front est annulée par son `ROLLBACK` ; aucun refus de queue ajouté (le refus se fait à l'instruction fautive, jamais en silence). |
| M3 audit : second `load` | `2e6b15a2`, test dans `2b453fea` | **Écart volontaire avec la consigne** : le second `load` ferme le pool précédent (`close_previous`) au lieu d'être refusé. Raison : le front recharge sa WebView sans redémarrer Rust (`window.location.reload()` dans `src/platform/relaunch.ts`, `lockLayer.ts`, `SyncDetailsForget.tsx`) puis rappelle `load` alors que l'ancien pool est encore enregistré ; un refus interdirait toute réouverture jusqu'au redémarrage. Le défaut visé (connexion orpheline) est corrigé. À confirmer par Ali ou l'audit. |
| M4 audit : raison de refus résiduelle | `2b453fea` | `clear_reason` avant chaque `execute` et `select`. Scénario de l'audit non reproduit : le test `sec01_9_a_stale_refusal_reason_never_survives_the_next_call` passe aussi sans le correctif (pas de rouge possible) ; il garde la propriété. |
| M7 audit : commentaire de `Cargo.toml` | `11930626` | Cite `guard.rs`, `guard_tests.rs`, `commands.rs` et `libsqlite3-sys`. Note : `src/platform/backup/tauriBackup.ts:93` avale l'échec du point de contrôle `wal_checkpoint` (voulu : le pragma est en liste blanche, `VACUUM INTO` lit le WAL). |
| Dette clippy | `becc9f17` | Une ligne dans `docs/dettes.md` (pas de story maintenant). |

Sauvegardes, export, import et synchro : relus par l'audit, aucune story nécessaire (la ligne « validation des chemins » de « Surfaces vérifiées » est soldée).

## Fichiers modifiés

- `src-tauri/vendor/tauri-plugin-sql/Cargo.toml` : dépendance optionnelle `libsqlite3-sys` 0.30.1, liée à la fonctionnalité `sqlite`.
- `src-tauri/vendor/tauri-plugin-sql/src/guard.rs` (nouveau) : `validate_db_url`, filtre lexical `VACUUM`, liste blanche de pragmas, autorisateur, limite d'attachement, crochet des refus.
- `src-tauri/vendor/tauri-plugin-sql/src/guard_tests.rs` (nouveau) : 24 tests du plugin.
- `src-tauri/vendor/tauri-plugin-sql/src/{error,lib,wrapper,commands}.rs` : variante `Error::Refused`, exports, `connect_in`, autorisateur posé dans `open_sqlite_pool`, contrôle de `execute` et `select`, `load`.
- `src-tauri/src/startup_gate.rs`, `src-tauri/src/lib.rs` : `install_sql_refusal_hook`, appelé au début de `run()` et avant l'enregistrement tardif du plugin.
- `src-tauri/tests/desktop/{sql_closed,main}.rs` : journal `sql-refused` et câblage.
- `src-tauri/tests/fixtures/front-sql.json` (généré), `tests/unit/sqlFrontReference.test.ts` : référence des instructions du front.
- `src-tauri/Cargo.lock` : une ligne (`libsqlite3-sys` dans les dépendances de `tauri-plugin-sql`).
- `docs/stories/SEC-01.md`, `docs/adr/0002-acces-base-et-drivers.md` (avenant SEC-01), `docs/journal.md`, `docs/dettes.md`, `tests/unit/sqlPragmaScan.test.ts` (revue), `src-tauri/Cargo.toml` (commentaire).
- Non touchés : `src/` (aucun fichier), `capabilities/`, `docs/decisions.md`, `docs/backlog.md`, `docs/audit-1.0.md` (à la charge d'Ali).

## Surfaces vérifiées (préparation de l'audit `security-privacy`)

Vérifiées par un test :
- `load` : dix-huit formes d'URL refusées (`validate_db_url`), aucun fichier ni dossier créé pour le chemin absolu et les deux formes `..` (`connect_in`).
- `ATTACH` (huit formes : commentaires, minuscules, chaînage, écriture), `DETACH`, par `execute` et par `select` ; fichier existant et fichier absent.
- `VACUUM` (six formes) refusé par `execute` et `select`, sans faux refus pour un littéral, un commentaire ou un identifiant ; `VACUUM INTO` bloqué aussi par la seule limite d'attachement.
- Pragmas : 27 formes hors liste refusées par `execute` et `select`, état relu par une autre connexion ; les fonctions-tables `pragma_*` passent par la même liste.
- Fonctions `load_extension` (1 et 2 arguments) et `fts3_tokenizer` ; tables virtuelles `rtree` et `fts4` ; `fts5` acceptée.
- Journal : code stable, aucune trace du texte SQL, de l'alias ni du chemin dans le fichier ; rafale de 1 001 refus bornée.

Relues dans le code, à confirmer par l'audit :
- Les blocs `unsafe` de `guard.rs` (descripteur de la connexion verrouillé par `LockedSqliteHandle`, chaîne C copiée avant usage, `Arc` volontairement non libéré : quelques octets par connexion).
- `readfile`, `writefile`, `edit` figurent dans la liste de refus mais n'existent pas dans la bibliothèque embarquée (SQLite n'appelle l'autorisateur que pour une fonction existante) : défense sans effet testable aujourd'hui.
- Une migration enregistrée par `Builder::add_migrations` (non utilisée par l'application) s'exécute hors de `execute` : non filtrée, mais son SQL est du code compilé.
- Une erreur sqlx « not authorized » est reconnue par le code 23 ou par le préfixe du message ; une autre source de « not authorized » serait classée `auth`.
- Le crochet de journal est global au processus et posé une seule fois (le premier gagne).

Laissées, hors story (à signaler) :
- **Validation des chemins des commandes de sauvegarde et de fichiers** (`backup.rs` : `restore_backup`, `check_backup`, `list_backups`, `reveal_backups_folder` ; `export_save_file`, `import_open_file`) : relues par l'audit, aucune story nécessaire (voir « Revue et audit »).
- Les autres plugins et commandes (fichiers, shell, notifications, opener) ; la clé de signature (CI-SEC-01).
- Ce que la WebView peut encore faire dans la base légitime : lire, modifier, supprimer ses données (inhérent), ouvrir une transaction longue.
- Les fichiers temporaires que SQLite écrit seul (tri volumineux) : non pilotables par le front (`temp_store_directory` refusé).

## Questions à Ali (sans blocage ; recommandation du product-owner entre parenthèses)

1. **Dépendance directe `libsqlite3-sys` et bloc `unsafe`.** Poser un autorisateur SQLite impose un petit bloc `unsafe` dans le plugin vendu (aucune nouvelle version de bibliothèque : 0.30.1 est déjà verrouillée). (Recommandation : accepter ; c'est la seule défense qui tienne contre `ATTACH` sans dépendre d'un filtre de texte.)
2. **Liste blanche de pragmas.** Tout pragma hors `foreign_keys`, `journal_mode` (WAL) et `wal_checkpoint` est refusé, y compris ceux dont un outil de diagnostic futur pourrait avoir besoin (`table_info`, `integrity_check`). (Recommandation : la liste blanche stricte ; tout besoin futur passera par cette liste, avec une ligne d'ADR.)
3. **Sauvegardes de la base.** Elles utilisent `rusqlite` en Rust, hors du pool, donc inchangées. Si Ali préfère que la fiche exige aussi un contrôle d'URL des chemins de `backup.rs`, c'est une autre story. (Recommandation : ne rien ajouter dans SEC-01 ; je n'ai pas relu la validation des chemins des commandes de sauvegarde pour cette fiche, l'audit `security-privacy` de la clôture le fait et ouvre une story si elle manque.)
4. **Placement.** L'étape 5 suit T-TECH-01 comme dans le plan du 2026-10-17. Rien n'empêche de faire SEC-01 avant (dossiers disjoints : Rust contre `src/features`). (Recommandation : garder l'ordre d'Ali ; les deux peuvent se chevaucher en développement si aucune des deux ne touche `src-tauri/Cargo.lock` en même temps.)
