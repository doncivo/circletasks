//! Plugin Swift ct-files (FILES-IOS-01, ADR 0009 avenant lot F point A1) : **aucune commande déclarée**, donc aucune permission `ct-files:*`
//! générée : la WebView ne peut appeler aucune commande du plugin (test `config.rs`). Seul Rust l'appelle (`CtFiles::call`).

const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
