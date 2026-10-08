//! Plugin Swift notification-actions (ADR 0012 avenant N-03, N3.2) : commandes appelées par la WebView, transmises à Swift par Tauri
//! (sur mobile, une commande de plugin sans gestionnaire Rust est transmise à la méthode Swift du même nom en lowerCamelCase).
//! Les permissions `notification-actions:allow-<commande>` sont générées ici ; seule la capability iOS les accorde (test `config.rs`).

const COMMANDS: &[&str] = &["drain", "ack", "status", "register_action_types", "register_listener", "remove_listener"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
