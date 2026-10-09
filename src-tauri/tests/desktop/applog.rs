//! I-04 (ADR 0014) : journal technique persistant. Rotation (256 Kio, `.1` remplacé, 512 Kio au plus), ligne tronquée à 4 Kio avec marque,
//! effacement, liens refusés, fichier corrompu lu sans panique, assainissement (vecteurs partagés avec Vitest), formes strictes, plafond
//! d'un appel, limitation de débit, écritures internes avant `init`.

use std::fs;
use std::path::Path;

use circletasks_lib::applog::{
    append_in, append_lines, clear_in, init, is_code, is_iso_instant, is_scope, line_of, normalize, read_entries, sanitize_detail, write, write_count, write_error, LogEntry, LogEntryIn, RateTable, CURRENT_FILE,
    MAX_FILE_BYTES, MAX_LINE_BYTES, PREVIOUS_FILE, TRUNCATED,
};
use serde_json::Value;

const VECTORS: &str = include_str!("../../../tests/fixtures/logs/sanitize-vectors.json");
const NOW: u64 = 1_791_446_400; // 2026-10-08T08:00:00Z

fn entry(scope: &str, code: &str, detail: &str) -> LogEntryIn {
    LogEntryIn { at: "2026-10-08T08:00:00.000Z".to_owned(), scope: scope.to_owned(), code: code.to_owned(), detail: detail.to_owned(), n: None }
}

fn size(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

// --- critère 5 : assainissement, seconde barrière (mêmes vecteurs que sanitize.test.ts) ---

#[test]
fn i04_5_code_field_is_sanitized_with_the_shared_vectors() {
    let vectors: Value = serde_json::from_str(VECTORS).unwrap();
    let list = vectors["codeVectors"].as_array().unwrap();
    assert!(list.len() >= 10);
    for vector in list {
        let code = vector["code"].as_str().unwrap();
        let expected = if vector["valid"].as_bool().unwrap() { code } else { "invalid" };
        assert_eq!(normalize(&entry("sync", code, ""), "2026-10-08T08:00:00.000Z").code, expected, "{code:?}");
    }
}

#[test]
fn i04_5_sanitize_detail_matches_the_shared_vectors() {
    let vectors: Value = serde_json::from_str(VECTORS).unwrap();
    let list = vectors["vectors"].as_array().unwrap();
    assert!(list.len() >= 25);
    for vector in list {
        let input = match vector.get("repeat") {
            Some(repeat) => repeat[0].as_str().unwrap().repeat(usize::try_from(repeat[1].as_u64().unwrap()).unwrap()),
            None => vector["input"].as_str().unwrap().to_owned(),
        };
        assert_eq!(sanitize_detail(&input), vector["expected"].as_str().unwrap(), "{input:?}");
    }
}

#[test]
fn i04_forms_are_strict_and_invalid_values_are_replaced() {
    assert!(is_scope("sync") && is_scope("import-pick") && is_scope("sync-rust") && is_scope("catalog-en"));
    assert!(!is_scope("") && !is_scope("Sync") && !is_scope("-x") && !is_scope("desktop:sync") && !is_scope(&"a".repeat(41)));
    assert!(is_code("too-large") && is_code("sync-now") && is_code("v1.2"));
    assert!(!is_code("Titre secret") && !is_code("é") && !is_code(&"a".repeat(65)));
    assert!(is_iso_instant("2026-10-08T08:00:00Z") && is_iso_instant("2026-10-08T08:00:00.123Z"));
    assert!(!is_iso_instant("2026-10-08 08:00:00") && !is_iso_instant("hier") && !is_iso_instant("2026-10-08T08:00:00+02:00"));
    let normalized = normalize(&LogEntryIn { at: "hier".into(), scope: "Desktop:Sync".into(), code: "Titre secret".into(), detail: "C:\\Users\\Ali\\x".into(), n: Some(1) }, "2026-10-08T08:00:00.000Z");
    assert_eq!(normalized, LogEntry { at: "2026-10-08T08:00:00.000Z".into(), scope: "invalid".into(), code: "invalid".into(), detail: "[masqué]".into(), n: None });
}

// --- critère 4 : rotation, troncature, effacement, liens, fichier corrompu ---

#[test]
fn i04_4_rotation_keeps_at_most_two_files_of_256_kib() {
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    let line = line_of(&normalize(&entry("sync", "sync-now", &"x".repeat(200)), "2026-10-08T08:00:00.000Z"));
    let per_file = usize::try_from(MAX_FILE_BYTES).unwrap() / (line.len() + 1);
    let lines: Vec<String> = (0..per_file + 10).map(|_| line.clone()).collect();
    append_lines(&logs, &lines).unwrap();
    assert!(logs.join(PREVIOUS_FILE).is_file(), "au-delà de 256 Kio, le fichier devient .1");
    assert!(size(&logs.join(PREVIOUS_FILE)) <= MAX_FILE_BYTES);
    assert_eq!(size(&logs.join(CURRENT_FILE)), 10 * (line.len() as u64 + 1));
    // Une seconde rotation remplace l'ancien .1 : jamais plus de 512 Kio au total.
    let previous_before = fs::read(logs.join(PREVIOUS_FILE)).unwrap();
    let later = line_of(&normalize(&entry("sync", "sync-later", &"y".repeat(200)), "2026-10-08T09:00:00.000Z"));
    let lines: Vec<String> = (0..per_file + 10).map(|_| later.clone()).collect();
    append_lines(&logs, &lines).unwrap();
    assert_ne!(fs::read(logs.join(PREVIOUS_FILE)).unwrap(), previous_before);
    assert!(size(&logs.join(PREVIOUS_FILE)) + size(&logs.join(CURRENT_FILE)) <= 2 * MAX_FILE_BYTES);
    assert_eq!(fs::read_dir(&logs).unwrap().count(), 2, "aucun autre fichier");
}

#[test]
fn i04_4_a_line_above_4_kib_is_truncated_with_a_mark() {
    let long = LogEntry { at: "2026-10-08T08:00:00.000Z".into(), scope: "sync".into(), code: "x".into(), detail: "é".repeat(5_000), n: None };
    let line = line_of(&long);
    assert!(line.len() <= MAX_LINE_BYTES, "{}", line.len());
    let parsed: LogEntry = serde_json::from_str(&line).unwrap();
    assert!(parsed.detail.ends_with(TRUNCATED));
    assert!(parsed.detail.len() > 3_000, "la troncature garde l'essentiel");
}

#[test]
fn i04_4_and_8_clear_removes_both_files_then_logs_cleared_is_the_first_entry() {
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    fs::create_dir_all(&logs).unwrap();
    fs::write(logs.join(PREVIOUS_FILE), "{\"at\":\"2026-10-07T08:00:00Z\",\"scope\":\"sync\",\"code\":\"a\",\"detail\":\"\"}\n").unwrap();
    fs::write(logs.join(CURRENT_FILE), "{\"at\":\"2026-10-07T09:00:00Z\",\"scope\":\"sync\",\"code\":\"b\",\"detail\":\"\"}\n").unwrap();
    clear_in(&logs, NOW).unwrap();
    assert!(!logs.join(PREVIOUS_FILE).exists());
    let entries = read_entries(&logs, 500).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!((entries[0].scope.as_str(), entries[0].code.as_str()), ("logs", "logs-cleared"));
}

#[test]
fn i04_4_a_corrupted_file_is_read_with_replacement_and_marked_without_panic() {
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    fs::create_dir_all(&logs).unwrap();
    let mut bytes = b"{\"at\":\"2026-10-07T08:00:00Z\",\"scope\":\"sync\",\"code\":\"ok\",\"detail\":\"\"}\n".to_vec();
    bytes.extend_from_slice(&[0xff, 0xfe, b'x', b'\n']);
    bytes.extend_from_slice(b"pas du json\n{\"at\":\"2026-10-07T09:00:00Z\",\"scope\":\"Pas Valide\",\"code\":\"x\",\"detail\":\"\"}\n");
    fs::write(logs.join(CURRENT_FILE), bytes).unwrap();
    let entries = read_entries(&logs, 500).unwrap();
    let codes: Vec<&str> = entries.iter().map(|e| e.code.as_str()).collect();
    assert_eq!(codes, ["ok", "unreadable-line", "unreadable-line", "unreadable-line"]);
    assert!(entries[1..].iter().all(|e| e.scope == "log" && e.detail.is_empty() && e.at == "2026-10-07T08:00:00Z"));
}

#[test]
fn i04_4_reading_returns_the_last_entries_previous_file_first() {
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    fs::create_dir_all(&logs).unwrap();
    let line = |code: &str| format!("{{\"at\":\"2026-10-07T08:00:00Z\",\"scope\":\"sync\",\"code\":\"{code}\",\"detail\":\"\"}}\n");
    fs::write(logs.join(PREVIOUS_FILE), format!("{}{}", line("a"), line("b"))).unwrap();
    fs::write(logs.join(CURRENT_FILE), format!("{}{}", line("c"), line("d"))).unwrap();
    let codes = |max| read_entries(&logs, max).unwrap().into_iter().map(|e| e.code).collect::<Vec<_>>();
    assert_eq!(codes(500), ["a", "b", "c", "d"]);
    assert_eq!(codes(3), ["b", "c", "d"]);
    assert!(read_entries(&dir.path().join("absent"), 500).unwrap().is_empty(), "journal absent : vide");
}

#[test]
fn i04_4_a_logs_folder_that_is_a_link_is_neither_read_nor_written() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("ailleurs");
    fs::create_dir_all(&real).unwrap();
    fs::write(real.join(CURRENT_FILE), "{\"at\":\"2026-10-07T08:00:00Z\",\"scope\":\"sync\",\"code\":\"a\",\"detail\":\"\"}\n").unwrap();
    let logs = dir.path().join("logs");
    #[cfg(windows)]
    let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&logs).arg(&real).output().map(|o| o.status.success()).unwrap_or(false);
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&real, &logs).is_ok();
    assert!(made, "lien créé");
    assert_eq!(read_entries(&logs, 500).unwrap_err().code, "unsafe-file");
    assert_eq!(append_in(&logs, &mut RateTable::new(), &[entry("sync", "b", "")], NOW).unwrap_err().code, "unsafe-file");
    assert_eq!(clear_in(&logs, NOW).unwrap_err().code, "unsafe-file");
    assert_eq!(fs::read_dir(&real).unwrap().count(), 1, "rien d'écrit ni de supprimé à travers le lien");
}

#[test]
fn i04_4_a_log_file_that_is_a_link_is_neither_read_nor_written() {
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    fs::create_dir_all(&logs).unwrap();
    let target = dir.path().join("cible.txt");
    fs::write(&target, b"secret").unwrap();
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(&target, logs.join(CURRENT_FILE));
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(&target, logs.join(CURRENT_FILE));
    if made.is_ok() {
        assert_eq!(read_entries(&logs, 500).unwrap_err().code, "unsafe-file");
        assert_eq!(append_in(&logs, &mut RateTable::new(), &[entry("sync", "b", "")], NOW).unwrap_err().code, "unsafe-file");
        assert_eq!(fs::read(&target).unwrap(), b"secret");
        // « Effacer » retire le lien lui-même, jamais sa cible : le journal repart.
        clear_in(&logs, NOW).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"secret");
        assert_eq!(read_entries(&logs, 500).unwrap().len(), 1);
    }
    // Un dossier à la place du fichier courant : refusé aussi.
    let other = tempfile::tempdir().unwrap();
    let logs = other.path().join("logs");
    fs::create_dir_all(logs.join(CURRENT_FILE)).unwrap();
    assert_eq!(append_in(&logs, &mut RateTable::new(), &[entry("sync", "b", "")], NOW).unwrap_err().code, "unsafe-file");
}

// --- ADR 0014 §2 : plafond d'un appel, limitation de débit ---

#[test]
fn i04_more_than_100_entries_are_refused_and_nothing_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    let many: Vec<LogEntryIn> = (0..101).map(|_| entry("sync", "a", "")).collect();
    assert_eq!(append_in(&logs, &mut RateTable::new(), &many, NOW).unwrap_err().code, "too-many");
    assert!(!logs.exists());
}

#[test]
fn i04_a_burst_of_the_same_entry_is_limited_to_10_per_minute_then_summarized() {
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    let mut rates = RateTable::new();
    let burst: Vec<LogEntryIn> = (0..15).map(|_| entry("sync", "sync-now", "")).collect();
    assert_eq!(append_in(&logs, &mut rates, &burst, NOW).unwrap(), 10);
    // Une autre entrée la même minute passe (le couple est différent).
    assert_eq!(append_in(&logs, &mut rates, &[entry("backup", "backup-daily", "")], NOW + 5).unwrap(), 1);
    // Minute suivante : résumé `log` / `suppressed` (n = 5), puis la nouvelle entrée.
    assert_eq!(append_in(&logs, &mut rates, &[entry("sync", "sync-now", "")], NOW + 61).unwrap(), 2);
    let entries = read_entries(&logs, 500).unwrap();
    let summary = entries.iter().find(|e| e.code == "suppressed").expect("résumé");
    assert_eq!((summary.scope.as_str(), summary.detail.as_str(), summary.n), ("log", "sync sync-now", Some(5)));
    assert_eq!(entries.last().unwrap().code, "sync-now");
}

// --- ADR 0014 §2 : écritures internes à Rust, avant et après `init` ---

#[test]
fn i04_internal_writes_wait_in_memory_until_init_then_are_written() {
    write("backup-recovery", "recovery-conflict");
    write_count("export", "temp-purged", 3);
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    init(logs.clone());
    write("backup", "restore-marker-failed");
    assert_eq!(write_error(), None);
    let entries = read_entries(&logs, 500).unwrap();
    let pairs: Vec<(&str, &str, Option<u32>)> = entries.iter().map(|e| (e.scope.as_str(), e.code.as_str(), e.n)).collect();
    assert!(pairs.contains(&("backup-recovery", "recovery-conflict", None)));
    assert!(pairs.contains(&("export", "temp-purged", Some(3))));
    assert_eq!(pairs.last(), Some(&("backup", "restore-marker-failed", None)));
    assert!(entries.iter().all(|e| e.detail.is_empty()), "aucun texte dynamique");
}

// --- QA du lot F : lots de lignes maximales, chemins et jetons jamais écrits, journal de 2 × 256 Kio jamais dépassé ---

#[test]
fn i04_qa_batches_of_maximal_lines_never_exceed_two_files_of_256_kib() {
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    let fat = |tag: char| LogEntryIn { at: "2026-10-08T08:00:00.000Z".into(), scope: "sync".into(), code: "fat".into(), detail: tag.to_string().repeat(10_000), n: None };
    let mut rates = RateTable::new();
    // 100 lignes de près de 4 Kio par appel, dix appels (4 Mio demandés) : seul le plafond de 2 fichiers de 256 Kio tient.
    for round in 0..10_u8 {
        let entries: Vec<LogEntryIn> = (0..100).map(|i| LogEntryIn { code: format!("fat-{round}-{i}"), ..fat('a') }).collect();
        append_in(&logs, &mut rates, &entries, NOW + u64::from(round) * 120).unwrap();
        assert!(size(&logs.join(CURRENT_FILE)) <= MAX_FILE_BYTES, "tour {round} : fichier courant {}", size(&logs.join(CURRENT_FILE)));
        assert!(size(&logs.join(PREVIOUS_FILE)) <= MAX_FILE_BYTES, "tour {round} : fichier .1 {}", size(&logs.join(PREVIOUS_FILE)));
        assert_eq!(fs::read_dir(&logs).unwrap().count() <= 2, true, "aucun autre fichier (ni .tmp)");
    }
    // Le journal reste lisible de bout en bout (aucune ligne coupée par la rotation).
    let entries = read_entries(&logs, 500).unwrap();
    assert!(!entries.is_empty() && entries.iter().all(|e| e.code != "unreadable-line"), "lignes coupées par la rotation");
}

#[test]
fn i04_qa_paths_urls_and_tokens_in_a_detail_never_reach_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    let nasty = [
        r"échec C:\Users\Ali\Documents\Titre privé.csv",
        "échec /private/var/mobile/Containers/Data/Application/ABC/Documents/x.db",
        "échec file:///private/var/x/y.csv",
        "échec https://exemple.org/p?token=SECRET123",
        "échec ali@example.com",
        "échec Bearer abcdefghijklmnop.qrstuvwxyz",
        &format!("échec {}", "0123456789abcdef".repeat(2)),
    ];
    let entries: Vec<LogEntryIn> = nasty.iter().enumerate().map(|(i, d)| entry("backup", &format!("c{i}"), d)).collect();
    append_in(&logs, &mut RateTable::new(), &entries, NOW).unwrap();
    let text = fs::read_to_string(logs.join(CURRENT_FILE)).unwrap();
    for leaked in ["Users", "Ali", "Titre privé", "/private", "Containers", "file://", "SECRET123", "example.com", "abcdefghijklmnop", "0123456789abcdef"] {
        assert!(!text.contains(leaked), "« {leaked} » écrit dans le journal :\n{text}");
    }
    assert_eq!(text.lines().count(), nasty.len());
}
