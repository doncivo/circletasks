//! Plugin Swift folder-bookmark (ADR 0011 §22 point 1) : **aucune commande déclarée**, donc aucune permission `folder-bookmark:*` générée :
//! la WebView ne peut appeler aucune commande du plugin (test `config.rs`). Seul Rust l'appelle (`FolderBookmark::call`).

const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
