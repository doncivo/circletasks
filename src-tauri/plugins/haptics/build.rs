//! Plugin Swift haptics (ADR 0013 §1.1) : trois commandes, appelées par le JS (`src/platform/haptics/tauriHaptics.ts`) ; une permission
//! `allow-<commande>` générée par commande, accordées par `capabilities/haptics-ios.json` (iOS seulement, liste exacte).

const COMMANDS: &[&str] = &["impact_feedback", "notification_feedback", "selection_feedback"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
