//! SEC-01 (bloquant B7) : plugin SQL fermé, vu depuis le programme complet. Les refus (URL, ATTACH, VACUUM, pragmas, fonctions) et la
//! relecture des instructions du front (critère 11) sont testés dans le plugin vendu (`vendor/tauri-plugin-sql/src/guard_tests.rs`) ;
//! ici : chaque refus écrit une ligne `sql-refused` au journal (sans texte SQL ni chemin, rafales bornées) et le crochet est câblé là où
//! le plugin est construit.

use circletasks_lib::applog::read_entries;
use circletasks_lib::startup_gate::install_sql_refusal_hook;
use tauri_plugin_sql::{open_sqlite_pool, DbPool};

/// Dossier de test dans le dossier cible du dépôt (jamais le dossier temporaire du système).
fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
}

/// Base temporaire du test (dans le dossier temporaire du test, qui vit dans `target/` via `tempfile` du dépôt).
async fn open(dir: &std::path::Path) -> DbPool {
    let url = format!("sqlite:{}", dir.join("circletasks.db").to_string_lossy());
    sqlx_create(&url).await;
    DbPool::Sqlite(open_sqlite_pool(&url).await.unwrap())
}

async fn sqlx_create(url: &str) {
    // `open_sqlite_pool` n'ouvre pas en création (sqlx sans `create_if_missing`) : le fichier vide est posé comme le fait `DbPool::connect`.
    let path = url.trim_start_matches("sqlite:");
    std::fs::File::create(path).unwrap();
}

/// Critère 14 : un refus dans le programme (crochet câblé par `startup_gate`) écrit `sql-refused` / code au journal, sans texte SQL ni
/// chemin ; 1 000 refus consécutifs ne produisent pas 1 000 lignes (10 par minute et par code, le reste résumé).
#[test]
fn sec01_14_refusals_are_logged_with_a_stable_code_and_bursts_are_bounded() {
    let _log_dir = crate::support::applog_dir_lock();
    // Le test peut commencer juste avant xx:xx:00 : une rafale à l'horloge réelle aurait alors légitimement 20 lignes.
    const MINUTE: u64 = 1_791_446_400;
    let mut clock = circletasks_lib::applog::clock_for_tests(MINUTE + 59);
    install_sql_refusal_hook();
    let logs_root = scratch();
    let logs = logs_root.path().join("logs");
    circletasks_lib::applog::init(logs.clone());
    let dir = scratch();
    let secret_path = dir.path().join("secret-destination.db");
    let attach = format!("ATTACH DATABASE '{}' AS secret_alias", secret_path.to_string_lossy());
    runtime().block_on(async {
        let db = open(dir.path()).await;
        let error = db.execute(attach.clone(), vec![]).await.err().expect("ATTACH refusé");
        assert_eq!(error.to_string(), "sql-refused: attach", "code stable, aucun texte SQL ni chemin dans l'erreur");
        assert_eq!(db.select("PRAGMA writable_schema = 1".into(), vec![]).await.err().unwrap().to_string(), "sql-refused: pragma");
        assert_eq!(db.execute("VACUUM".into(), vec![]).await.err().unwrap().to_string(), "sql-refused: vacuum");
        for _ in 0..1000 {
            assert!(db.execute(attach.clone(), vec![]).await.is_err());
        }
        db.close().await;
    });
    let entries = read_entries(&logs, 500).unwrap();
    let refused: Vec<_> = entries.iter().filter(|e| e.scope == "sql-refused").collect();
    let codes: Vec<&str> = refused.iter().map(|e| e.code.as_str()).collect();
    assert!(codes.contains(&"attach") && codes.contains(&"pragma") && codes.contains(&"vacuum"), "{codes:?}");
    let attach_lines = refused.iter().filter(|e| e.code == "attach").count();
    // Exactement 10 lignes par minute et par code (RATE_PER_MINUTE) ; le résumé `log` / `suppressed` du reste est écrit à la minute suivante
    // (testé par `i04_a_burst_of_the_same_entry_is_limited_to_10_per_minute_then_summarized` dans applog.rs).
    assert_eq!(attach_lines, 10, "1 001 refus ATTACH : 10 lignes, pas 1 001");
    assert!(refused.iter().all(|e| e.at == circletasks_lib::applog::iso_of(MINUTE + 59)), "toute la rafale dans une seule minute injectée");
    // Ni texte SQL, ni chemin, ni alias dans le fichier du journal.
    let raw: String = std::fs::read_dir(&logs).unwrap().map(|f| std::fs::read_to_string(f.unwrap().path()).unwrap()).collect();
    for forbidden in ["ATTACH", "secret_alias", "secret-destination", "writable_schema", "VACUUM"] {
        assert!(!raw.contains(forbidden), "le journal contient {forbidden:?}");
    }
    assert!(refused.iter().all(|e| e.detail.is_empty()), "aucun texte dynamique");
    // Avance simulée, sans attente : la minute suivante rend un créneau et résume les 991 refus supprimés.
    clock.set(MINUTE + 60);
    runtime().block_on(async {
        let db = open(dir.path()).await;
        assert!(db.execute(attach, vec![]).await.is_err());
        db.close().await;
    });
    let next = read_entries(&logs, 500).unwrap();
    assert_eq!(next.iter().filter(|e| e.scope == "sql-refused" && e.code == "attach").count(), 11);
    assert!(next.iter().any(|e| e.scope == "log" && e.code == "suppressed" && e.detail == "sql-refused attach" && e.n == Some(991)));
}

/// Câblage : le crochet est posé au début de `run` (avant le plugin) et avant l'enregistrement tardif du plugin (iPhone, tests).
#[test]
fn sec01_14_the_refusal_hook_is_wired_before_the_plugin_is_built() {
    let lib = include_str!("../../src/lib.rs");
    let gate = include_str!("../../src/startup_gate.rs");
    let run = lib.find("pub fn run()").unwrap();
    assert!(lib.find("startup_gate::install_sql_refusal_hook()").unwrap() > run);
    assert!(lib.find("startup_gate::install_sql_refusal_hook()").unwrap() < lib.find("tauri_plugin_sql::Builder").unwrap());
    assert!(gate.find("    install_sql_refusal_hook();").unwrap() < gate.find("app.plugin(tauri_plugin_sql::Builder").unwrap());
    assert!(gate.contains("applog::write(\"sql-refused\", code)"));
}
