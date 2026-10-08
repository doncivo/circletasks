//! Plugin Swift reminders (ADR 0008 §10.4) : commandes appelées par la WebView, transmises à Swift par Tauri (sur mobile, une commande de
//! plugin sans gestionnaire Rust est transmise à la méthode Swift du même nom en lowerCamelCase). Les permissions `reminders:allow-<commande>`
//! sont générées ici ; seule la capability iOS `reminders-ios.json` les accorde (test `config.rs`).

const COMMANDS: &[&str] = &["status", "request_access", "lists", "fetch", "upsert", "set_completed", "delete", "register_listener", "remove_listener"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
