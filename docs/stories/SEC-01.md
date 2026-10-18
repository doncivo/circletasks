# SEC-01 — Plugin SQL fermé : une seule base, ni ATTACH ni VACUUM INTO (bloquant B7)

Module : M16 Sécurité (technique, sans équivalent au PRD : écart à noter dans docs/decisions.md) · Ordre de construction : palier 1.0, **étape 5** (après T-TECH-01) · Agents : **desktop-tauri** (code Rust du plugin vendu, tests Rust) + **security-privacy** (revue de la liste des refus, audit de clôture) · Relecture : code-reviewer · Estimation : **5 h** (alerte à Ali et arrêt si le réel dépasse **7,5 h**, soit +50 %) · Statut : **fiche écrite, à développer**
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

## Preuves (à remplir)

| Élément | Valeur |
|---|---|
| Rouge avant : commit et message d'échec exact des critères 2, 3, 4, 5, 7, 8, 9 sur `main` | |
| Vert après : commit | |
| Vérification : aucun code d'autorisation pour `VACUUM` dans la documentation SQLite (lien ou citation) | |
| Voie retenue pour poser l'autorisateur (`after_connect` + `libsqlite3-sys` 0.30.1) | |
| Voie retenue pour le critère 11 (migrations rejouées sur le pool Rust) | |
| Recherche du critère 15 (résultat) | |
| Commandes locales du module (date, tests) | |
| CI « suite verte » (branche, run) | |
| Audit `security-privacy` (date, conclusion) | |

## Écarts (vide)

## Questions à Ali (sans blocage ; recommandation du product-owner entre parenthèses)

1. **Dépendance directe `libsqlite3-sys` et bloc `unsafe`.** Poser un autorisateur SQLite impose un petit bloc `unsafe` dans le plugin vendu (aucune nouvelle version de bibliothèque : 0.30.1 est déjà verrouillée). (Recommandation : accepter ; c'est la seule défense qui tienne contre `ATTACH` sans dépendre d'un filtre de texte.)
2. **Liste blanche de pragmas.** Tout pragma hors `foreign_keys`, `journal_mode` (WAL) et `wal_checkpoint` est refusé, y compris ceux dont un outil de diagnostic futur pourrait avoir besoin (`table_info`, `integrity_check`). (Recommandation : la liste blanche stricte ; tout besoin futur passera par cette liste, avec une ligne d'ADR.)
3. **Sauvegardes de la base.** Elles utilisent `rusqlite` en Rust, hors du pool, donc inchangées. Si Ali préfère que la fiche exige aussi un contrôle d'URL des chemins de `backup.rs`, c'est une autre story. (Recommandation : ne rien ajouter dans SEC-01 ; je n'ai pas relu la validation des chemins des commandes de sauvegarde pour cette fiche, l'audit `security-privacy` de la clôture le fait et ouvre une story si elle manque.)
4. **Placement.** L'étape 5 suit T-TECH-01 comme dans le plan du 2026-10-17. Rien n'empêche de faire SEC-01 avant (dossiers disjoints : Rust contre `src/features`). (Recommandation : garder l'ordre d'Ali ; les deux peuvent se chevaucher en développement si aucune des deux ne touche `src-tauri/Cargo.lock` en même temps.)
