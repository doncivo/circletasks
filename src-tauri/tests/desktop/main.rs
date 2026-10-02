//! Tests de l'intégration PC (D-01 à D-03). Un seul exécutable de test : sous Windows, il est lié
//! avec le manifeste comctl32 v6 (build.rs), sans lequel un binaire utilisant tauri ne démarre pas.
//! Les tests sont ici et non dans `src/` pour cette raison (les tests unitaires de la lib sont
//! désactivés dans Cargo.toml).

mod backup;
mod config;
mod logic;
mod quit;
mod updater;
