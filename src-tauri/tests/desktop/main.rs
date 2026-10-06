//! Tests de l'intégration PC (D-01 à D-03). Un seul exécutable de test : sous Windows, il est lié
//! avec le manifeste comctl32 v6 (build.rs), sans lequel un binaire utilisant tauri ne démarre pas.
//! Les tests sont ici et non dans `src/` pour cette raison (les tests unitaires de la lib sont
//! désactivés dans Cargo.toml).

mod backup;
mod capture;
mod calendars;
mod config;
mod export;
mod focus;
mod import;
mod logic;
mod ocr;
mod quit;
mod restore;
mod restore_hardening;
mod restore_recovery;
mod shortcut;
mod sync_crypto;
mod sync_fixes;
mod sync_folder;
mod sync_forget;
mod sync_forget_qa;
mod sync_key;
mod sync_pairing;
mod sync_pairing_qa;
mod sync_pairing_y06;
mod sync_qa_crypto;
mod sync_qa_folder;
mod sync_reset;
mod sync_store;
mod sync_support;
mod updater;
mod window;
