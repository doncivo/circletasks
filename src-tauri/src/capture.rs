//! Mini-fenêtre de capture rapide (Q-01, ADR 0006) : seconde fenêtre Tauri `quick-capture`, créée
//! masquée au démarrage puis montrée / cachée (jamais détruite : ouverture en moins de 300 ms).
//!
//! La fenêtre n'ouvre pas la base : le front de la mini-fenêtre envoie `capture:submit` à la fenêtre
//! principale, seule à écrire. Aucun texte d'interface ici.

use std::sync::{Mutex, MutexGuard};

use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::desktop::{show_main_window, MAIN_WINDOW, QUICK_ADD_EVENT};

/// Libellé de la mini-fenêtre.
pub const CAPTURE_WINDOW: &str = "quick-capture";
/// Page de la mini-fenêtre (second point d'entrée Vite, `capture.html`).
pub const CAPTURE_PAGE: &str = "capture.html";
/// Événement envoyé à la mini-fenêtre quand elle vient d'être montrée : le front vide et focalise le champ.
pub const SHOWN_EVENT: &str = "capture://shown";
/// Événement envoyé à la mini-fenêtre quand elle perd le focus : le front la ferme si le champ est vide.
pub const BLURRED_EVENT: &str = "capture://blurred";
/// Largeur logique (Q-01 critère 1).
pub const WINDOW_WIDTH: f64 = 520.0;
/// Hauteur logique par défaut.
pub const DEFAULT_HEIGHT: f64 = 160.0;
/// Hauteur maximale : la liste de suggestions (# et @) peut agrandir la fenêtre.
pub const MAX_HEIGHT: f64 = 440.0;

/// Ce que fait la combinaison globale selon l'état de la fenêtre.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToggleAction {
    /// Fenêtre cachée : la montrer, centrée, champ vide et focalisé.
    Show,
    /// Fenêtre ouverte mais sans le focus (saisie en cours) : lui rendre le focus sans rien perdre.
    Focus,
    /// Fenêtre ouverte et active : la fermer (bascule, Q-01 critère 6).
    Hide,
}

/// Bascule : cachée, elle s'ouvre ; active, elle se ferme ; ouverte en arrière-plan, elle revient devant.
pub fn toggle_action(visible: bool, focused: bool) -> ToggleAction {
    match (visible, focused) {
        (false, _) => ToggleAction::Show,
        (true, false) => ToggleAction::Focus,
        (true, true) => ToggleAction::Hide,
    }
}

/// Hauteur logique demandée par le front, ramenée entre la hauteur par défaut et le maximum.
pub fn clamp_height(requested: f64) -> f64 {
    if requested.is_nan() {
        return DEFAULT_HEIGHT;
    }
    requested.clamp(DEFAULT_HEIGHT, MAX_HEIGHT)
}

/// Coin supérieur gauche (pixels physiques) d'une fenêtre de `window` pixels centrée sur un écran.
pub fn centered_origin(monitor_position: (i32, i32), monitor_size: (u32, u32), window: (u32, u32)) -> (i32, i32) {
    let offset = |screen: u32, win: u32| -> i32 { (i64::from(screen) - i64::from(win)).div_euclid(2) as i32 };
    (monitor_position.0 + offset(monitor_size.0, window.0), monitor_position.1 + offset(monitor_size.1, window.1))
}

/// Taille physique d'une taille logique à l'échelle `scale` d'un écran.
pub fn physical_size(logical: (f64, f64), scale: f64) -> (u32, u32) {
    ((logical.0 * scale).round().max(1.0) as u32, (logical.1 * scale).round().max(1.0) as u32)
}

/// Fenêtre qui avait le focus avant l'ouverture (HWND), pour le lui rendre à la fermeture.
#[derive(Default)]
pub struct CaptureState {
    previous: Mutex<isize>,
}

impl CaptureState {
    fn lock(&self) -> MutexGuard<'_, isize> {
        self.previous.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(windows)]
mod foreground {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsWindow, SetForegroundWindow};

    pub fn current() -> isize {
        // SAFETY: appel sans argument.
        unsafe { GetForegroundWindow() }.0 as isize
    }

    pub fn restore(handle: isize) {
        if handle == 0 {
            return;
        }
        let hwnd = HWND(handle as *mut core::ffi::c_void);
        // SAFETY: `IsWindow` accepte n'importe quel handle ; on ne rend le focus qu'à une fenêtre qui existe encore.
        unsafe {
            if IsWindow(Some(hwnd)).as_bool() {
                let _ = SetForegroundWindow(hwnd);
            }
        }
    }
}

#[cfg(not(windows))]
mod foreground {
    pub fn current() -> isize {
        0
    }
    pub fn restore(_handle: isize) {}
}

fn capture_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(CAPTURE_WINDOW)
}

/// Écran actif : celui du curseur, sinon l'écran principal.
fn active_monitor(app: &AppHandle) -> Option<Monitor> {
    app.cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
}

fn center_on_active_monitor(app: &AppHandle, window: &WebviewWindow) {
    let _ = window.set_size(LogicalSize::new(WINDOW_WIDTH, DEFAULT_HEIGHT));
    let Some(monitor) = active_monitor(app) else {
        let _ = window.center();
        return;
    };
    let size = physical_size((WINDOW_WIDTH, DEFAULT_HEIGHT), monitor.scale_factor());
    let (x, y) = centered_origin((monitor.position().x, monitor.position().y), (monitor.size().width, monitor.size().height), size);
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Montre la mini-fenêtre, centrée sur l'écran actif, au premier plan, champ focalisé par le front.
pub fn show(app: &AppHandle) {
    let Some(window) = capture_window(app) else { return };
    if let Some(state) = app.try_state::<CaptureState>() {
        *state.lock() = foreground::current();
    }
    center_on_active_monitor(app, &window);
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit_to(CAPTURE_WINDOW, SHOWN_EVENT, ());
}

/// Cache la mini-fenêtre. Si elle était active, le focus revient à l'application précédente ;
/// si l'utilisateur est déjà ailleurs (fermeture sur perte de focus), rien n'est volé.
pub fn hide(app: &AppHandle) {
    let Some(window) = capture_window(app) else { return };
    let was_focused = window.is_focused().unwrap_or(false);
    let _ = window.hide();
    if was_focused {
        if let Some(state) = app.try_state::<CaptureState>() {
            foreground::restore(*state.lock());
        }
    }
}

/// Combinaison globale ou « Ajout rapide » du menu : bascule la mini-fenêtre. Sans mini-fenêtre
/// (création échouée), repli sur l'ouverture d'Aujourd'hui avec le champ focalisé (D-04).
pub fn trigger(app: &AppHandle) {
    let Some(window) = capture_window(app) else {
        show_main_window(app);
        let _ = app.emit_to(MAIN_WINDOW, QUICK_ADD_EVENT, ());
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    match toggle_action(visible, focused) {
        ToggleAction::Show => show(app),
        ToggleAction::Focus => {
            let _ = window.set_focus();
        }
        ToggleAction::Hide => hide(app),
    }
}

/// Crée la mini-fenêtre, masquée et chargée d'avance. Un échec n'empêche pas l'app de démarrer.
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    app.manage(CaptureState::default());
    let window = WebviewWindowBuilder::new(app, CAPTURE_WINDOW, WebviewUrl::App(CAPTURE_PAGE.into()))
        .title("Capture rapide")
        .inner_size(WINDOW_WIDTH, DEFAULT_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .build()?;
    let handle = app.clone();
    window.on_window_event(move |event| match event {
        // Alt+F4 : on cache, la fenêtre sert de nouveau à la prochaine ouverture.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide(&handle);
        }
        WindowEvent::Focused(false) => {
            let _ = handle.emit_to(CAPTURE_WINDOW, BLURRED_EVENT, ());
        }
        _ => {}
    });
    Ok(())
}

/// Ferme la mini-fenêtre (Entrée, Échap, perte de focus avec champ vide).
#[tauri::command]
pub fn hide_quick_capture(app: AppHandle) {
    hide(&app);
}

/// Agrandit la fenêtre pour la liste de suggestions (hauteur logique, bornée).
#[tauri::command]
pub fn resize_quick_capture(app: AppHandle, height: f64) {
    if let Some(window) = capture_window(&app) {
        let _ = window.set_size(LogicalSize::new(WINDOW_WIDTH, clamp_height(height)));
    }
}
