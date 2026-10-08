//! Plugin Swift privacy-shield (ADR 0013 §2.5) : une commande, appelée par le JS (`src/platform/privacyShield/tauriPrivacyShield.ts`) au
//! démarrage et à chaque changement du réglage ; permission accordée par `capabilities/privacy-shield-ios.json` (iOS seulement).

const COMMANDS: &[&str] = &["set_enabled"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
