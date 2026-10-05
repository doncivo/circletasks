//! Mini-fenêtre Focus du PC (M10, F-01), ouverte par Rust (correctif du troisième audit H1, ADR 0011 section 2.1).
//!
//! La fenêtre `main` ne peut plus créer de fenêtre (`focus-launcher.json` n'accorde que les trois commandes ci-dessous) : sans cela, un
//! script de `main` pourrait fabriquer une fenêtre libellée `pairing`. Libellé, URL et options sont fixés ici ; la WebView ne fournit
//! qu'une position mémorisée, recentrée si elle ne tombe plus sur un écran. Comportement de F-01 inchangé.

use serde::Deserialize;
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Libellé de la mini-fenêtre (capability `focus.json`).
pub const FOCUS_WINDOW: &str = "focus";
/// Même application, en mode « vue Focus » (`src/main.tsx`).
pub const FOCUS_URL: &str = "index.html?window=focus";
/// 340 × 460 px logiques, non redimensionnable (F-01 D3).
pub const FOCUS_WIDTH: f64 = 340.0;
pub const FOCUS_HEIGHT: f64 = 460.0;

/// Position mémorisée (pixels physiques).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct FocusPosition {
    pub x: i32,
    pub y: i32,
}

/// Écran : origine et taille en pixels physiques.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// La position tombe-t-elle encore sur un écran ? (même règle que l'ancienne version TypeScript : un écran débranché ne doit pas
/// rendre la fenêtre introuvable).
pub fn is_on_screen(position: FocusPosition, screens: &[Screen]) -> bool {
    screens.iter().any(|s| {
        let (x, y) = (i64::from(position.x), i64::from(position.y));
        let (sx, sy) = (i64::from(s.x), i64::from(s.y));
        x >= sx - 40 && y >= sy && x < sx + i64::from(s.width) - 80 && y < sy + i64::from(s.height) - 80
    })
}

/// Position retenue : la position mémorisée si elle est sur un écran, sinon aucune (fenêtre centrée).
pub fn usable_position(position: Option<FocusPosition>, screens: &[Screen]) -> Option<FocusPosition> {
    position.filter(|p| is_on_screen(*p, screens))
}

fn focus_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(FOCUS_WINDOW)
}

fn reveal(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn screens(app: &AppHandle) -> Vec<Screen> {
    app.available_monitors()
        .map(|monitors| monitors.iter().map(|m| Screen { x: m.position().x, y: m.position().y, width: m.size().width, height: m.size().height }).collect())
        .unwrap_or_default()
}

/// Ouvre la mini-fenêtre (ou la ramène si elle existe déjà).
#[tauri::command]
pub async fn focus_window_open(app: AppHandle, position: Option<FocusPosition>) -> Result<(), String> {
    if let Some(window) = focus_window(&app) {
        reveal(&window);
        return Ok(());
    }
    let usable = usable_position(position, &screens(&app));
    let window = WebviewWindowBuilder::new(&app, FOCUS_WINDOW, WebviewUrl::App(FOCUS_URL.into()))
        .title("Focus")
        .inner_size(FOCUS_WIDTH, FOCUS_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    if let Some(p) = usable {
        let _ = window.set_position(PhysicalPosition::new(p.x, p.y));
    }
    reveal(&window);
    Ok(())
}

/// Ramène la mini-fenêtre au premier plan.
#[tauri::command]
pub fn focus_window_bring_to_front(app: AppHandle) {
    if let Some(window) = focus_window(&app) {
        reveal(&window);
    }
}

/// Ferme (détruit) la mini-fenêtre.
#[tauri::command]
pub fn focus_window_close(app: AppHandle) {
    if let Some(window) = focus_window(&app) {
        let _ = window.destroy();
    }
}
