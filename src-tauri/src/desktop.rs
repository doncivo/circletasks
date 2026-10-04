//! Intégration système du PC Windows (M16) : zone de notification, fermeture = réduction,
//! instance unique, démarrage réduit (D-01, D-02) et enregistrement des plugins PC
//! (autostart, updater, process, opener). Compilé uniquement sur desktop (`cfg(desktop)`).
//!
//! Aucune notification n'est émise ici : le PC n'envoie jamais de rappel (CLAUDE.md).

use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

/// Libellé de la fenêtre principale (tauri.conf.json).
pub const MAIN_WINDOW: &str = "main";
/// Argument de démarrage réduit, passé par le plugin autostart (D-02).
pub const MINIMIZED_ARG: &str = "--minimized";
/// Événement envoyé à la fenêtre principale par l'entrée « Ajout rapide » (D-01, critère 5).
pub const QUICK_ADD_EVENT: &str = "desktop://quick-add";
/// Événement envoyé au front avant de quitter : il termine ses écritures puis appelle `confirm_quit`.
pub const QUITTING_EVENT: &str = "desktop://quitting";
/// Attente maximale de la confirmation du front avant de quitter malgré tout.
pub const QUIT_GRACE: Duration = Duration::from_secs(2);
/// Identifiant de l'icône de la zone de notification.
pub const TRAY_ID: &str = "main-tray";
/// Info-bulle de l'icône : nom du produit, identique dans toutes les langues.
pub const TRAY_TOOLTIP: &str = "CircleTasks";

/// Libellés de repli du menu, utilisés seulement entre la création de l'icône et la réception
/// des textes du front (`set_tray_labels`). EXCEPTION documentée à la règle « textes dans
/// src/i18n » (ADR 0006) : sans eux le menu serait vide si l'interface ne démarre pas, et
/// « Quitter » serait inaccessible. Un test Vitest vérifie qu'ils restent égaux à `fr.ts`.
pub fn fallback_labels() -> TrayLabels {
    TrayLabels {
        open: "Ouvrir CircleTasks".to_owned(),
        quick_add: "Ajout rapide".to_owned(),
        sync: "Synchroniser".to_owned(),
        quit: "Quitter".to_owned(),
        sync_enabled: false,
    }
}

/// Erreur renvoyée au front par les commandes : `{ code, message }` (ADR 0001).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandError {
    /// Code stable, lisible par le front (`tray-unavailable`, `menu`).
    pub code: &'static str,
    /// Détail technique, jamais affiché tel quel à l'utilisateur.
    pub message: String,
}

/// Textes du menu de la zone de notification, fournis par le front (src/i18n).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    /// « Ouvrir CircleTasks ».
    pub open: String,
    /// « Ajout rapide ».
    pub quick_add: String,
    /// « Synchroniser ».
    pub sync: String,
    /// « Quitter ».
    pub quit: String,
    /// Faux tant que la synchronisation n'existe pas (Y-03) : l'entrée est grisée.
    pub sync_enabled: bool,
}

/// Actions du menu, dans l'ordre d'affichage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    Open,
    QuickAdd,
    Sync,
    Quit,
}

impl TrayAction {
    /// Identifiant d'entrée de menu.
    pub const fn id(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::QuickAdd => "quick-add",
            Self::Sync => "sync",
            Self::Quit => "quit",
        }
    }

    /// Action correspondant à un identifiant d'entrée de menu.
    pub fn from_id(id: &str) -> Option<Self> {
        [Self::Open, Self::QuickAdd, Self::Sync, Self::Quit]
            .into_iter()
            .find(|action| action.id() == id)
    }
}

/// Entrée du menu, indépendante de Tauri (testable).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrayEntry {
    Item { action: TrayAction, label: String, enabled: bool },
    Separator,
}

/// Disposition du menu (D-01, critère 3) : Ouvrir, Ajout rapide, Synchroniser, séparateur, Quitter.
pub fn menu_layout(labels: &TrayLabels) -> Vec<TrayEntry> {
    let item = |action, label: &str, enabled| TrayEntry::Item { action, label: label.to_owned(), enabled };
    vec![
        item(TrayAction::Open, &labels.open, true),
        item(TrayAction::QuickAdd, &labels.quick_add, true),
        item(TrayAction::Sync, &labels.sync, labels.sync_enabled),
        TrayEntry::Separator,
        item(TrayAction::Quit, &labels.quit, true),
    ]
}

/// Vrai si le lancement demande une fenêtre masquée (démarrage avec Windows, D-02).
pub fn is_minimized_launch<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|arg| arg.as_ref() == MINIMIZED_ARG)
}

/// Vrai si la fermeture de la fenêtre doit seulement la masquer (D-01, critère 1).
pub fn hides_on_close(window_label: &str) -> bool {
    window_label == MAIN_WINDOW
}

fn build_menu(app: &AppHandle, labels: &TrayLabels) -> tauri::Result<Menu<Wry>> {
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    for entry in menu_layout(labels) {
        match entry {
            TrayEntry::Item { action, label, enabled } => {
                items.push(Box::new(MenuItem::with_id(app, action.id(), label, enabled, None::<&str>)?));
            }
            TrayEntry::Separator => items.push(Box::new(PredefinedMenuItem::separator(app)?)),
        }
    }
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|item| item.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// Affiche la fenêtre principale au premier plan, là où elle se trouvait (D-01, critères 2 et 4).
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn run_action(app: &AppHandle, action: TrayAction) {
    match action {
        TrayAction::Open => show_main_window(app),
        // Q-01 : « Ajout rapide » ouvre la mini-fenêtre ; sans elle, repli sur Aujourd'hui (capture::trigger).
        TrayAction::QuickAdd => crate::capture::trigger(app),
        // Grisée tant que la synchronisation n'existe pas (Y-03) : rien à faire.
        TrayAction::Sync => {}
        // Quitter : le front termine ses écritures en cours (attente bornée), puis `exit` déclenche
        // `RunEvent::Exit`, où tauri-plugin-sql ferme ses connexions.
        TrayAction::Quit => quit_gracefully(app),
    }
}

/// Porte de sortie : le front confirme que ses écritures en cours sont terminées.
#[derive(Default)]
pub struct QuitGate {
    sender: Mutex<Option<mpsc::Sender<()>>>,
}

impl QuitGate {
    /// Ouvre une demande de sortie ; le récepteur reçoit la confirmation du front.
    pub fn begin(&self) -> mpsc::Receiver<()> {
        let (tx, rx) = mpsc::channel();
        *self.sender.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        rx
    }

    /// Confirmation du front ; sans effet si aucune sortie n'est en cours.
    pub fn confirm(&self) {
        if let Some(tx) = self.sender.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(());
        }
    }
}

/// Attend la confirmation au plus `grace` ; renvoie vrai si elle est arrivée à temps.
pub fn wait_for_confirmation(receiver: &mpsc::Receiver<()>, grace: Duration) -> bool {
    receiver.recv_timeout(grace).is_ok()
}

fn quit_gracefully(app: &AppHandle) {
    let receiver = app.state::<QuitGate>().begin();
    if app.emit_to(MAIN_WINDOW, QUITTING_EVENT, ()).is_err() {
        app.exit(0);
        return;
    }
    let handle = app.clone();
    // Hors du fil du menu : l'attente ne bloque pas l'interface.
    std::thread::spawn(move || {
        let _confirmed = wait_for_confirmation(&receiver, QUIT_GRACE);
        handle.exit(0);
    });
}

/// Le front a terminé ses écritures en cours : la sortie peut continuer (D-01, critère 7).
#[tauri::command]
pub fn confirm_quit(gate: tauri::State<'_, QuitGate>) {
    gate.confirm();
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| Image::new_owned(vec![0; 4], 1, 1));
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(TRAY_TOOLTIP)
        .menu(&build_menu(app, &fallback_labels())?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if let Some(action) = TrayAction::from_id(event.id.as_ref()) {
                run_action(app, action);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Remplace le menu de la zone de notification par les textes de l'interface (src/i18n).
///
/// Appelée par le front au démarrage. Erreurs : `tray-unavailable` (icône absente),
/// `menu` (construction du menu impossible).
#[tauri::command]
pub fn set_tray_labels(app: AppHandle, labels: TrayLabels) -> Result<(), CommandError> {
    let tray = app.tray_by_id(TRAY_ID).ok_or_else(|| CommandError {
        code: "tray-unavailable",
        message: "icône de la zone de notification introuvable".to_owned(),
    })?;
    let menu = build_menu(&app, &labels).map_err(|e| CommandError { code: "menu", message: e.to_string() })?;
    tray.set_menu(Some(menu)).map_err(|e| CommandError { code: "menu", message: e.to_string() })
}

/// Enregistre les plugins PC, la fermeture en réduction et la zone de notification.
pub fn configure(builder: tauri::Builder<Wry>) -> tauri::Builder<Wry> {
    builder
        // Instance unique : doit être le premier plugin (D-01, critère 8). Un second lancement
        // affiche la fenêtre existante, sauf s'il est lui-même un démarrage réduit.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !is_minimized_launch(&args) {
                show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![MINIMIZED_ARG]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(crate::shortcut::plugin())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if hides_on_close(window.label()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            app.manage(QuitGate::default());
            crate::shortcut::manage(app.handle());
            // Q-01 : mini-fenêtre créée masquée ; un échec n'empêche pas l'app de démarrer (repli sur Aujourd'hui).
            if let Err(error) = crate::capture::setup(app.handle()) {
                crate::capture::record_setup_failure(app.handle(), error.to_string());
            }
            create_tray(app.handle())?;
            if !is_minimized_launch(std::env::args()) {
                show_main_window(app.handle());
            }
            Ok(())
        })
}
