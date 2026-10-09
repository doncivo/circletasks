//! Plugin Swift web-auth (ADR 0008 §9.1) : **aucune commande déclarée**, donc aucune permission `web-auth:*` générée :
//! la WebView ne peut appeler aucune commande du plugin (test `tests/desktop/web_auth.rs`). Seul Rust l'appelle (`WebAuth::call`).

const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
