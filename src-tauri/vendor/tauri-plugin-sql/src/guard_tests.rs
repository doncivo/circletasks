//! CircleTasks (SEC-01, bloquant B7) : le plugin SQL est fermé. Une seule base (`sqlite:circletasks.db`), ni `ATTACH`, ni `VACUUM INTO`,
//! ni pragma hors liste blanche, ni fonction ou table virtuelle dangereuse. Tous les tests passent par l'API existante du plugin
//! (`open_sqlite_pool`, `DbPool::execute` / `select` / `connect_in`), comme le ferait la WebView, et n'écrivent que dans `target/`.

use std::path::{Path, PathBuf};

use serde_json::Value as JsonValue;
use sqlx::{Connection, Pool, Sqlite, migrate::MigrateDatabase};

use crate::guard::validate_db_url;
use crate::wrapper::open_sqlite_pool;
use crate::{DbPool, Error};

/// Dossier temporaire dans `target/` du dépôt (jamais le dossier temporaire du système).
fn target_dir(prefix: &str) -> tempfile::TempDir {
    tempfile::Builder::new().prefix(prefix).tempdir_in(concat!(env!("CARGO_MANIFEST_DIR"), "/../../target")).expect("dossier de test dans target/")
}

/// Refus attendu, de code `code` ; message précis sinon (accepté, ou autre erreur).
fn assert_refused<T>(result: Result<T, Error>, code: &str, ctx: &str) {
    match result {
        Err(Error::Refused(got)) if got == code => {}
        Err(other) => panic!("{ctx} : refus `{code}` attendu, autre erreur obtenue : {other}"),
        Ok(_) => panic!("{ctx} : refus `{code}` attendu, mais le plugin a accepté"),
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    url: String,
    pool: Pool<Sqlite>,
    db: DbPool,
}

impl Fixture {
    async fn new(prefix: &str) -> Self {
        let dir = target_dir(prefix);
        let url = format!("sqlite:{}", dir.path().join("t.db").to_str().unwrap());
        Sqlite::create_database(&url).await.unwrap();
        let pool = open_sqlite_pool(&url).await.unwrap();
        let db = DbPool::Sqlite(pool.clone());
        Self { dir, url, pool, db }
    }

    async fn exec(&self, sql: &str) -> Result<(u64, crate::LastInsertId), Error> {
        self.db.execute(sql.to_string(), vec![]).await
    }

    async fn sel(&self, sql: &str) -> Result<Vec<indexmap::IndexMap<String, JsonValue>>, Error> {
        self.db.select(sql.to_string(), vec![]).await
    }

    /// Chemin d'une cible d'attaque (dans `target/`, jamais ailleurs) et son écriture SQL.
    fn victim(&self, name: &str) -> (PathBuf, String) {
        let path = self.dir.path().join(name);
        let sql = path.to_str().unwrap().replace('\'', "''");
        (path, sql)
    }

    /// Relecture d'un état persistant par une AUTRE connexion (sans autorisateur) : le refus n'a rien changé.
    async fn second_connection_value(&self, pragma: &str) -> JsonValue {
        let mut conn = sqlx::SqliteConnection::connect(&self.url).await.unwrap();
        let row = sqlx::query(&format!("PRAGMA {pragma}")).fetch_one(&mut conn).await.unwrap();
        let value = crate::decode::sqlite::to_json(sqlx::Row::try_get_raw(&row, 0).unwrap()).unwrap();
        conn.close().await.unwrap();
        value
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critères 1 à 3 : `load`
// ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn sec01_1_the_only_accepted_url_is_circletasks_db() {
    assert!(validate_db_url("sqlite:circletasks.db").is_ok());
}

#[test]
fn sec01_2_every_other_url_is_refused_with_the_url_code() {
    let refused = [
        r"sqlite:C:\Users\x\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\x.db",
        "sqlite:/tmp/x.db",
        r"sqlite:\\?\C:\x.db",
        "sqlite:../x.db",
        "sqlite:sub/../../x.db",
        r"sqlite:sub\circletasks.db",
        "sqlite:CircleTasks.db",
        "sqlite:circletasks.db?mode=ro",
        "sqlite:circletasks.db-wal",
        "sqlite::memory:",
        "sqlite://circletasks.db",
        "sqlite:file:circletasks.db",
        "sqlite:",
        "sqlite:circletasks.db ",
        "mysql://h/d",
        "postgres://h/d",
        "circletasks.db",
        "",
    ];
    for url in refused {
        assert_refused(validate_db_url(url), "url", &format!("validate_db_url({url:?})"));
    }
}

/// Contenu d'un dossier (noms triés), pour prouver qu'un refus ne crée ni fichier ni dossier.
fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sec01_3_load_with_an_absolute_path_or_dotdot_refuses_and_creates_nothing() {
    let base = target_dir("db-load-");
    let app_dir = base.path().join("app");
    let absolute = format!("sqlite:{}", base.path().join("escaped.db").to_str().unwrap());
    for url in [absolute.as_str(), "sqlite:../escaped.db", "sqlite:sub/../../escaped.db"] {
        let before = listing(base.path());
        let result = DbPool::connect_in(url, || app_dir.clone()).await;
        assert_refused(result, "url", &format!("connect_in({url:?})"));
        assert_eq!(listing(base.path()), before, "{url:?} : aucun fichier ni dossier ne doit être créé");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sec01_3_load_of_the_legitimate_url_creates_the_database_in_the_app_dir() {
    let base = target_dir("db-load-ok-");
    let app_dir = base.path().join("app");
    let db = DbPool::connect_in("sqlite:circletasks.db", || app_dir.clone()).await.unwrap_or_else(|e| panic!("{e}"));
    assert!(app_dir.join("circletasks.db").exists());
    db.close().await;
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critères 4 à 6 : ATTACH et DETACH
// ------------------------------------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sec01_4_execute_refuses_every_form_of_attach_and_creates_no_file() {
    let fx = Fixture::new("db-attach-").await;
    let forms: [(&str, &str); 8] = [
        ("attach-database", "ATTACH DATABASE '{p}' AS x"),
        ("attach", "ATTACH '{p}' AS x"),
        ("lower-case", "attach database '{p}' as x"),
        ("block-comment", "/* innocent */ ATTACH DATABASE '{p}' AS x"),
        ("line-comment", "-- innocent\nATTACH DATABASE '{p}' AS x"),
        ("line-comment-spaces", "--   \n   \t ATTACH DATABASE '{p}' AS x"),
        ("chained", "SELECT 1; ATTACH DATABASE '{p}' AS x"),
        ("then-write", "ATTACH DATABASE '{p}' AS x; CREATE TABLE x.t (a INTEGER)"),
    ];
    for (name, template) in forms {
        let (path, sql_path) = fx.victim(&format!("stolen-{name}.db"));
        let sql = template.replace("{p}", &sql_path);
        assert_refused(fx.exec(&sql).await, "attach", &format!("execute ({name})"));
        assert!(!path.exists(), "execute ({name}) : le fichier cible a été créé");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sec01_5_select_refuses_attach_too() {
    let fx = Fixture::new("db-attach-sel-").await;
    for (name, template) in [("plain", "ATTACH DATABASE '{p}' AS x"), ("chained", "SELECT 1; ATTACH DATABASE '{p}' AS x")] {
        let (path, sql_path) = fx.victim(&format!("stolen-select-{name}.db"));
        let sql = template.replace("{p}", &sql_path);
        assert_refused(fx.sel(&sql).await, "attach", &format!("select ({name})"));
        assert!(!path.exists(), "select ({name}) : le fichier cible a été créé");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sec01_6_detach_is_refused() {
    let fx = Fixture::new("db-detach-").await;
    assert_refused(fx.exec("DETACH DATABASE x").await, "attach", "execute DETACH DATABASE x");
    assert_refused(fx.exec("DETACH x").await, "attach", "execute DETACH x");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sec01_6_the_attached_database_limit_is_zero_independently_of_the_authorizer() {
    let fx = Fixture::new("db-limit-").await;
    let mut conn = fx.pool.acquire().await.unwrap();
    let mut handle = conn.lock_handle().await.unwrap();
    // SAFETY : descripteur valide tant que `handle` est tenu ; `-1` ne modifie pas la limite, il la lit.
    let limit = unsafe { libsqlite3_sys::sqlite3_limit(handle.as_raw_handle().as_ptr(), libsqlite3_sys::SQLITE_LIMIT_ATTACHED, -1) };
    assert_eq!(limit, 0, "SQLITE_LIMIT_ATTACHED doit valoir 0");
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 7 : VACUUM (filtre lexical)
// ------------------------------------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sec01_7_vacuum_in_any_form_is_refused_by_execute_and_select() {
    let fx = Fixture::new("db-vacuum-").await;
    let forms: [(&str, &str); 6] = [
        ("vacuum-into", "VACUUM INTO '{p}'"),
        ("lower-case", "vacuum into '{p}'"),
        ("comments", "/**/VACUUM/**/INTO '{p}'"),
        ("chained", "SELECT 1; VACUUM INTO '{p}'"),
        ("main-schema", "VACUUM main INTO '{p}'"),
        ("alone", "VACUUM"),
    ];
    for (name, template) in forms {
        let (path, sql_path) = fx.victim(&format!("copy-{name}.db"));
        let sql = template.replace("{p}", &sql_path);
        assert_refused(fx.exec(&sql).await, "vacuum", &format!("execute ({name})"));
        assert_refused(fx.sel(&sql).await, "vacuum", &format!("select ({name})"));
        assert!(!path.exists(), "({name}) : la copie de la base a été créée");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sec01_7_the_word_in_a_literal_a_comment_or_an_identifier_is_not_refused() {
    let fx = Fixture::new("db-vacuum-ok-").await;
    fx.exec("CREATE TABLE t (vacuum_count INTEGER, \"vacuum\" TEXT, [vacuum2] TEXT)").await.unwrap();
    for sql in [
        "SELECT 'vacuum'",
        "SELECT 'it''s a vacuum'",
        "SELECT 1 -- vacuum into somewhere",
        "/* vacuum */ SELECT 1",
        "SELECT vacuum_count, \"vacuum\", [vacuum2] FROM t",
        "SELECT `vacuum_count` FROM t",
    ] {
        fx.sel(sql).await.unwrap_or_else(|e| panic!("{sql:?} : faux refus : {e}"));
    }
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 8 : pragmas
// ------------------------------------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sec01_8_every_pragma_outside_the_white_list_is_refused_and_changes_nothing() {
    let fx = Fixture::new("db-pragma-").await;
    let (_, temp_dir_sql) = fx.victim("tmpdir");
    let refused = [
        "PRAGMA writable_schema = 1".to_string(),
        "PRAGMA trusted_schema = 1".to_string(),
        "PRAGMA journal_mode = DELETE".to_string(),
        "PRAGMA journal_mode = OFF".to_string(),
        "PRAGMA foreign_keys = OFF".to_string(),
        "PRAGMA foreign_keys = 0".to_string(),
        "PRAGMA main.foreign_keys = OFF".to_string(),
        format!("PRAGMA temp_store_directory = '{temp_dir_sql}'"),
        format!("PRAGMA data_store_directory = '{temp_dir_sql}'"),
        "PRAGMA user_version = 5".to_string(),
        "PRAGMA user_version".to_string(),
        "PRAGMA locking_mode = EXCLUSIVE".to_string(),
        "PRAGMA synchronous = OFF".to_string(),
        "PRAGMA mmap_size = 1000".to_string(),
        "PRAGMA application_id = 1".to_string(),
        "PRAGMA schema_version = 5".to_string(),
        "PRAGMA query_only = 1".to_string(),
        "PRAGMA ignore_check_constraints = 1".to_string(),
        "PRAGMA recursive_triggers = 1".to_string(),
        "PRAGMA secure_delete = 1".to_string(),
        "PRAGMA soft_heap_limit = 1000".to_string(),
        "PRAGMA hard_heap_limit = 1000".to_string(),
        "PRAGMA threads = 2".to_string(),
        "PRAGMA table_info(sqlite_master)".to_string(),
        "PRAGMA integrity_check".to_string(),
        "pragma writable_schema=1".to_string(),
        "/* c */ PRAGMA writable_schema = 1".to_string(),
    ];
    for sql in &refused {
        assert_refused(fx.exec(sql).await, "pragma", &format!("execute {sql:?}"));
        assert_refused(fx.sel(sql).await, "pragma", &format!("select {sql:?}"));
    }
    // L'état est inchangé (relecture par les pragmas autorisés, puis par une autre connexion pour ceux qui sont persistants).
    let fk = fx.sel("PRAGMA foreign_keys").await.unwrap();
    assert_eq!(fk[0]["foreign_keys"], JsonValue::from(1), "foreign_keys doit rester ON");
    let mode = fx.sel("PRAGMA journal_mode").await.unwrap();
    assert_eq!(mode[0]["journal_mode"], JsonValue::String("wal".into()));
    assert_eq!(fx.second_connection_value("user_version").await, JsonValue::from(0));
    assert_eq!(fx.second_connection_value("application_id").await, JsonValue::from(0));
    assert_eq!(fx.second_connection_value("journal_mode").await, JsonValue::String("wal".into()));
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 9 : fonctions et tables virtuelles
// ------------------------------------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sec01_9_dangerous_functions_and_virtual_tables_are_refused() {
    let fx = Fixture::new("db-function-").await;
    assert_refused(fx.sel("SELECT load_extension('x')").await, "function", "select load_extension");
    assert_refused(fx.sel("SELECT load_extension('x', 'y')").await, "function", "select load_extension (2 arguments)");
    assert_refused(fx.sel("SELECT fts3_tokenizer('x')").await, "function", "select fts3_tokenizer");
    assert_refused(fx.exec("CREATE VIRTUAL TABLE t USING rtree(id, a, b)").await, "vtable", "execute CREATE VIRTUAL TABLE rtree");
    assert_refused(fx.exec("CREATE VIRTUAL TABLE t USING fts4(a)").await, "vtable", "execute CREATE VIRTUAL TABLE fts4");
}

// ------------------------------------------------------------------------------------------------------------------------------
// Critère 10 : non-régression, les instructions que le front émet réellement
// ------------------------------------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sec01_10_the_statements_the_front_really_sends_still_pass() {
    let fx = Fixture::new("db-front-").await;
    fx.exec("PRAGMA foreign_keys = ON").await.unwrap();
    fx.exec("PRAGMA journal_mode = WAL").await.unwrap();
    let mode = fx.sel("PRAGMA journal_mode").await.unwrap();
    assert_eq!(mode[0]["journal_mode"], JsonValue::String("wal".into()));
    fx.sel("PRAGMA foreign_keys").await.unwrap();
    fx.exec("CREATE TABLE p (id INTEGER PRIMARY KEY, v TEXT)").await.unwrap();
    fx.exec("CREATE TABLE c (id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id), v TEXT)").await.unwrap();
    fx.exec("BEGIN IMMEDIATE").await.unwrap();
    fx.db.execute("INSERT INTO p (id, v) VALUES (?, ?)".into(), vec![JsonValue::from(1), JsonValue::from("a")]).await.unwrap();
    fx.db.execute("UPDATE p SET v = ? WHERE id = ?".into(), vec![JsonValue::from("b"), JsonValue::from(1)]).await.unwrap();
    fx.exec("SAVEPOINT s").await.unwrap();
    fx.exec("RELEASE s").await.unwrap();
    fx.exec("COMMIT").await.unwrap();
    let rows = fx.db.select("SELECT v FROM p WHERE id = ?".into(), vec![JsonValue::from(1)]).await.unwrap();
    assert_eq!(rows[0]["v"], JsonValue::String("b".into()));
    // Clé étrangère toujours active.
    assert!(fx.exec("INSERT INTO c (p, v) VALUES (99, 'orphan')").await.is_err());
    fx.exec("BEGIN IMMEDIATE").await.unwrap();
    fx.exec("DELETE FROM p").await.unwrap();
    fx.exec("ROLLBACK").await.unwrap();
    assert_eq!(fx.sel("SELECT COUNT(*) AS n FROM p").await.unwrap()[0]["n"], JsonValue::from(1));
    fx.exec("PRAGMA wal_checkpoint(TRUNCATE)").await.unwrap_or_else(|e| panic!("wal_checkpoint : {e}"));
    fx.sel("PRAGMA wal_checkpoint(TRUNCATE)").await.unwrap_or_else(|e| panic!("wal_checkpoint (select) : {e}"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sec01_10_fts5_tables_and_triggers_are_still_created() {
    let fx = Fixture::new("db-fts5-").await;
    fx.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT)").await.unwrap();
    fx.exec("CREATE VIRTUAL TABLE search_index USING fts5(title, content='tasks', content_rowid='id', tokenize='unicode61 remove_diacritics 2')")
        .await
        .unwrap_or_else(|e| panic!("fts5 : {e}"));
    fx.exec("CREATE TRIGGER tasks_ai AFTER INSERT ON tasks BEGIN INSERT INTO search_index(rowid, title) VALUES (new.id, new.title); END").await.unwrap();
    fx.exec("INSERT INTO tasks (title) VALUES ('Préparer la réunion')").await.unwrap();
    let rows = fx.sel("SELECT rowid FROM search_index WHERE search_index MATCH 'reunion'").await.unwrap();
    assert_eq!(rows.len(), 1);
    fx.exec("DROP TABLE search_index").await.unwrap();
}

/// Constat de la revue (SEC-01) : sqlx ouvre la base principale sans `SQLITE_OPEN_CREATE`, donc un `ATTACH` d'un fichier ABSENT échoue
/// déjà (« unable to open database ») ; le danger réel est l'`ATTACH` d'un fichier SQLite EXISTANT (lecture et écriture d'une autre
/// base : coffre, copie de sauvegarde). Ce test l'exerce, pour que le rouge soit une vraie attaque réussie et non une erreur d'ouverture.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sec01_4_attaching_an_existing_foreign_database_is_refused_and_not_written() {
    let fx = Fixture::new("db-attach-existing-").await;
    let (path, sql_path) = fx.victim("other.db");
    let other_url = format!("sqlite:{}", path.to_str().unwrap());
    Sqlite::create_database(&other_url).await.unwrap();
    let mut other = sqlx::SqliteConnection::connect(&other_url).await.unwrap();
    sqlx::query("CREATE TABLE secret (v TEXT)").execute(&mut other).await.unwrap();
    other.close().await.unwrap();
    assert_refused(fx.exec(&format!("ATTACH DATABASE '{sql_path}' AS x")).await, "attach", "execute ATTACH d'un fichier existant");
    assert_refused(fx.sel(&format!("ATTACH DATABASE '{sql_path}' AS x")).await, "attach", "select ATTACH d'un fichier existant");
}


/// Contournement essayé : les fonctions-tables `pragma_*` (lecture d'un pragma par `SELECT`) passent par l'autorisateur comme `PRAGMA`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sec01_8_pragma_table_functions_are_refused_like_pragmas() {
    let fx = Fixture::new("db-pragma-fn-").await;
    for sql in ["SELECT * FROM pragma_user_version", "SELECT * FROM pragma_database_list", "SELECT * FROM pragma_table_info('sqlite_master')", "SELECT * FROM pragma_writable_schema"] {
        assert_refused(fx.sel(sql).await, "pragma", sql);
    }
}

/// Défense en profondeur : la limite d'attachement (couche 2) bloque à elle seule `ATTACH` et `VACUUM INTO`, autorisateur retiré et
/// filtre lexical contourné (appel direct de sqlx sur la connexion).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sec01_6_the_limit_alone_blocks_attach_and_vacuum_into() {
    let fx = Fixture::new("db-limit-alone-").await;
    let (attached, attached_sql) = fx.victim("limit-attach.db");
    let (copy, copy_sql) = fx.victim("limit-copy.db");
    let mut conn = fx.pool.acquire().await.unwrap();
    {
        let mut handle = conn.lock_handle().await.unwrap();
        // SAFETY : descripteur valide tant que `handle` est tenu ; retire l'autorisateur pour ne tester que la limite.
        let rc = unsafe { libsqlite3_sys::sqlite3_set_authorizer(handle.as_raw_handle().as_ptr(), None, std::ptr::null_mut()) };
        assert_eq!(rc, libsqlite3_sys::SQLITE_OK);
    }
    let attach = sqlx::query(&format!("ATTACH DATABASE '{attached_sql}' AS x")).execute(&mut *conn).await;
    assert!(attach.as_ref().is_err_and(|e| e.to_string().contains("too many attached databases")), "ATTACH : {attach:?}");
    let vacuum = sqlx::query(&format!("VACUUM INTO '{copy_sql}'")).execute(&mut *conn).await;
    assert!(vacuum.is_err(), "VACUUM INTO doit échouer avec la limite à 0 : {vacuum:?}");
    assert!(!attached.exists() && !copy.exists());
}

// --- Fonctions pures : filtre lexical, liste blanche de pragmas, décisions de l'autorisateur ---

#[test]
fn sec01_7_lexical_filter_cases() {
    use crate::guard::mentions_vacuum;
    for yes in ["VACUUM", "vacuum", "VaCuUm INTO 'x'", "SELECT 1;VACUUM", "SELECT 1;\nvacuum", "/**/VACUUM/**/INTO 'x'", "-- c\nVACUUM", "SELECT 'a'; VACUUM", "SELECT \"a\"\"b\"; VACUUM", "SELECT 'a'' ' ; vacuum", "(VACUUM)", "x'00';vacuum"] {
        assert!(mentions_vacuum(yes), "{yes:?} doit être refusé");
    }
    for no in ["", "SELECT 'vacuum'", "SELECT \"vacuum\"", "SELECT [vacuum]", "SELECT `vacuum`", "-- vacuum", "/* vacuum */ SELECT 1", "SELECT vacuum_count", "SELECT avacuum", "SELECT :vacuum, @vacuum, $vacuum", "SELECT 'it''s vacuum'", "/* non terminé vacuum"] {
        assert!(!mentions_vacuum(no), "{no:?} ne doit pas être refusé");
    }
}

#[test]
fn sec01_8_pragma_white_list_cases() {
    use crate::guard::{REASON_PRAGMA, decide};
    let pragma = |name: &str, arg: Option<&str>| decide(libsqlite3_sys::SQLITE_PRAGMA, Some(name), arg);
    for (name, arg) in [("foreign_keys", None), ("foreign_keys", Some("ON")), ("FOREIGN_KEYS", Some("on")), ("foreign_keys", Some("1")), ("journal_mode", None), ("journal_mode", Some("WAL")), ("journal_mode", Some("wal")), ("wal_checkpoint", None), ("wal_checkpoint", Some("TRUNCATE")), ("data_version", None)] {
        assert_eq!(pragma(name, arg), None, "{name} {arg:?} doit passer");
    }
    for (name, arg) in [("foreign_keys", Some("OFF")), ("foreign_keys", Some("0")), ("foreign_keys", Some("")), ("journal_mode", Some("DELETE")), ("journal_mode", Some("OFF")), ("data_version", Some("1")), ("writable_schema", None), ("user_version", None), ("table_info", Some("t")), ("", None)] {
        assert_eq!(pragma(name, arg), Some(REASON_PRAGMA), "{name} {arg:?} doit être refusé");
    }
    assert_eq!(decide(libsqlite3_sys::SQLITE_PRAGMA, None, None), Some(REASON_PRAGMA), "pragma sans nom");
}

#[test]
fn sec01_9_authorizer_decisions_for_functions_and_virtual_tables() {
    use crate::guard::{REASON_ATTACH, REASON_FUNCTION, REASON_VTABLE, decide};
    use libsqlite3_sys as ffi;
    for f in ["load_extension", "LOAD_EXTENSION", "fts3_tokenizer", "readfile", "writefile", "edit"] {
        assert_eq!(decide(ffi::SQLITE_FUNCTION, None, Some(f)), Some(REASON_FUNCTION), "{f}");
    }
    for f in ["lower", "json_extract", "bm25", "highlight"] {
        assert_eq!(decide(ffi::SQLITE_FUNCTION, None, Some(f)), None, "{f}");
    }
    assert_eq!(decide(ffi::SQLITE_CREATE_VTABLE, Some("t"), Some("fts5")), None);
    assert_eq!(decide(ffi::SQLITE_CREATE_VTABLE, Some("t"), Some("FTS5")), None);
    assert_eq!(decide(ffi::SQLITE_DROP_VTABLE, Some("t"), Some("fts5")), None);
    assert_eq!(decide(ffi::SQLITE_CREATE_VTABLE, Some("t"), Some("rtree")), Some(REASON_VTABLE));
    assert_eq!(decide(ffi::SQLITE_CREATE_VTABLE, Some("t"), None), Some(REASON_VTABLE));
    assert_eq!(decide(ffi::SQLITE_ATTACH, Some("x.db"), None), Some(REASON_ATTACH));
    assert_eq!(decide(ffi::SQLITE_DETACH, Some("x"), None), Some(REASON_ATTACH));
    for action in [ffi::SQLITE_SELECT, ffi::SQLITE_READ, ffi::SQLITE_INSERT, ffi::SQLITE_UPDATE, ffi::SQLITE_DELETE, ffi::SQLITE_CREATE_TABLE, ffi::SQLITE_CREATE_INDEX, ffi::SQLITE_CREATE_TRIGGER, ffi::SQLITE_TRANSACTION, ffi::SQLITE_SAVEPOINT, ffi::SQLITE_RECURSIVE, ffi::SQLITE_ALTER_TABLE, ffi::SQLITE_DROP_TABLE, ffi::SQLITE_ANALYZE, ffi::SQLITE_REINDEX] {
        assert_eq!(decide(action, Some("t"), Some("c")), None, "action {action}");
    }
}
