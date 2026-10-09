//! Tests de l'intégration PC (D-01 à D-03). Un seul exécutable de test : sous Windows, il est lié
//! avec le manifeste comctl32 v6 (build.rs), sans lequel un binaire utilisant tauri ne démarre pas.
//! Les tests sont ici et non dans `src/` pour cette raison (les tests unitaires de la lib sont
//! désactivés dans Cargo.toml).

mod applog;
mod backup;
mod capture;
mod calendars;
mod config;
mod db_diagnostics;
mod export;
mod export_ios;
mod focus;
mod import;
mod logic;
mod notification_actions;
mod ocr;
mod quit;
mod restore;
mod restore_hardening;
mod restore_ios;
mod restore_recovery;
mod shortcut;
mod support;
mod sync_bookmark;
mod sync_closed_segments;
mod sync_crypto;
mod sync_fixes;
mod sync_folder;
mod sync_forget;
mod sync_fs_conformance;
mod sync_forget_qa;
mod sync_ios_y02;
mod sync_key;
mod sync_pairing;
mod sync_pairing_qa;
mod sync_pairing_y06;
mod sync_qa_crypto;
mod sync_qa_folder;
mod sync_reset;
mod sync_store;
mod sync_support;
mod sync_tz;
mod sync_y_tech_02;
mod updater;
mod window;
