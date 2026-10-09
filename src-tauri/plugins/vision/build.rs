//! Plugin Swift vision (ADR 0015 §0 et ADR 0011 §22 point 1) : **aucune commande déclarée**, donc aucune permission `vision:*` générée :
//! la WebView ne peut appeler aucune commande du plugin (test `config.rs`). Seul Rust l'appelle (`Vision::call`).

const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
