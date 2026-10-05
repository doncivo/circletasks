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
/// Événement envoyé à la fenêtre principale par l'entrée « Synchroniser maintenant » (Y-03, critère 4).
pub const TRAY_SYNC_NOW_EVENT: &str = "tray-sync-now";
/// Attente maximale de la confirmation du front avant de quitter malgré tout : le dernier cycle de synchro a 5 s au plus
/// (ADR 0011 section 10.1, Y-02 critère 1), puis la sortie a lieu quoi qu'il arrive.
pub const QUIT_GRACE: Duration = Duration::from_secs(5);
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
        sync: "Synchroniser maintenant".to_owned(),
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
    /// Vrai si la synchronisation est configurée (Y-03) : l'entrée lance un cycle silencieux ; faux : elle ouvre la fenêtre
    /// principale sur Réglages › Synchronisation (D1). L'entrée n'est jamais grisée.
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

/// Disposition du menu (D-01, critère 3) : Ouvrir, Ajout rapide, Synchroniser maintenant, séparateur, Quitter. Toutes les entrées
/// sont actives (Y-03 D1 : sans synchro configurée, « Synchroniser maintenant » guide vers Réglages au lieu d'être grisée).
pub fn menu_layout(labels: &TrayLabels) -> Vec<TrayEntry> {
    let item = |action, label: &str, enabled| TrayEntry::Item { action, label: label.to_owned(), enabled };
    vec![
        item(TrayAction::Open, &labels.open, true),
        item(TrayAction::QuickAdd, &labels.quick_add, true),
        item(TrayAction::Sync, &labels.sync, true),
        TrayEntry::Separator,
        item(TrayAction::Quit, &labels.quit, true),
    ]
}

/// Effet de « Synchroniser maintenant » (Y-03, critères 4 et 5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncTrayEffect {
    /// Synchro configurée : événement `tray-sync-now` seul, la fenêtre reste où elle est (cycle silencieux).
    Silent,
    /// Synchro non configurée : la fenêtre principale s'affiche, le front ouvre Réglages › Synchronisation (D1).
    ShowSettings,
}

/// Effet de l'entrée selon l'état connu du front (`sync_enabled` reçu par `set_tray_labels`).
pub fn sync_tray_effect(sync_configured: bool) -> SyncTrayEffect {
    if sync_configured {
        SyncTrayEffect::Silent
    } else {
        SyncTrayEffect::ShowSettings
    }
}

/// Dernier état « synchro configurée » reçu du front (géré par Tauri, mis à jour par `set_tray_labels`).
#[derive(Default)]
pub struct TraySyncState(Mutex<bool>);

impl TraySyncState {
    pub fn set(&self, configured: bool) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = configured;
    }

    pub fn get(&self) -> bool {
        *self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
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
        // Y-03 : la fenêtre principale lance `syncNow('tray')` ; sans synchro configurée, elle s'affiche sur Réglages.
        TrayAction::Sync => {
            let configured = app.try_state::<TraySyncState>().map(|state| state.get()).unwrap_or(false);
            if sync_tray_effect(configured) == SyncTrayEffect::ShowSettings {
                show_main_window(app);
            }
            let _ = app.emit_to(MAIN_WINDOW, TRAY_SYNC_NOW_EVENT, ());
        }
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
    if let Some(state) = app.try_state::<TraySyncState>() {
        state.set(labels.sync_enabled);
    }
    let menu = build_menu(&app, &labels).map_err(|e| CommandError { code: "menu", message: e.to_string() })?;
    tray.set_menu(Some(menu)).map_err(|e| CommandError { code: "menu", message: e.to_string() })
}

/// Début du texte de la boîte montrée quand la récupération d'une restauration interrompue échoue. Exception assumée à « textes dans
/// `src/i18n` » : la boîte précède toute WebView ; ce début est celui de `backup.recoveryFailed` (vérifié par `recoveryMessage.test.ts`).
pub const RECOVERY_FAILED_MESSAGE: &str = "Restauration interrompue : redémarrez CircleTasks.";

/// Texte complet de la boîte : le début, le code d'erreur et la consigne (sans chemin personnel : le dossier est désigné par `%APPDATA%`).
pub fn recovery_failed_text(code: &str, identifier: &str) -> String {
    format!(
        "{RECOVERY_FAILED_MESSAGE}\n\nCode : {code}\n\nSi ce message revient : fermez CircleTasks, ouvrez le dossier %APPDATA%\\{identifier} et conservez les fichiers « .restore-old » (ne les supprimez pas), puis demandez de l'aide."
    )
}

/// Voie retenue pour une récupération impossible : QUITTER. La fenêtre principale n'existe pas encore (`create: false`, voir `create_main_window`) :
/// aucune WebView n'est vivante pendant la boîte, donc aucune base ne peut être ouverte ni créée. `setup` renvoie ensuite une erreur et
/// `Builder::run` échoue. Une boîte système bloquante (`MessageBoxW`, sous Windows) montre le message d'abord ; seul le code d'erreur est journalisé,
/// sans chemin. Les fichiers `.restore-old` restent intacts.
fn abort_startup_after_failed_recovery(code: &str, identifier: &str) -> Box<dyn std::error::Error> {
    eprintln!("[backup] récupération au démarrage impossible : {code}");
    #[cfg(windows)]
    {
        use windows::core::{w, HSTRING};
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        // SAFETY : appel Win32 sans fenêtre parente, chaînes valides pour la durée de l'appel.
        unsafe {
            MessageBoxW(None, &HSTRING::from(recovery_failed_text(code, identifier)), w!("CircleTasks"), MB_OK | MB_ICONERROR);
        }
    }
    format!("restauration interrompue non récupérée ({code})").into()
}

/// Construit une fenêtre depuis sa configuration (`tauri.conf.json`), quel que soit son champ `create`. Générique sur le runtime pour être testée.
pub fn build_window_from_config<R: tauri::Runtime>(app: &tauri::AppHandle<R>, config: &tauri::utils::config::WindowConfig) -> tauri::Result<()> {
    if app.get_webview_window(&config.label).is_none() {
        tauri::WebviewWindowBuilder::from_config(app, config)?.build()?;
    }
    Ok(())
}

/// Crée la fenêtre principale (Windows : sa configuration porte `create: false`, voir `tauri.windows.conf.json`), APRÈS la récupération d'une
/// restauration interrompue : la WebView, et donc le plugin SQL, n'existent qu'une fois les fichiers de la base remis en ordre.
pub fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    build_window_from_config(app, &config)
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
            // P-04 : une restauration interrompue (arrêt brutal pendant l'échange des fichiers) est récupérée AVANT toute WebView : la fenêtre
            // principale (`create: false`) n'existe pas encore. Si la récupération échoue, l'app ne démarre pas : ni base neuve ni base ouverte
            // sur un état à moitié restauré (voir `abort_startup_after_failed_recovery`). Puis seulement, la fenêtre est construite.
            // Dossier de données introuvable (`no-data-dir`) : impossible de savoir si une restauration est en suspens, donc l'app ne démarre pas non plus.
            let Ok(dir) = tauri::Manager::path(app).app_config_dir() else {
                return Err(abort_startup_after_failed_recovery("no-data-dir", &app.config().identifier));
            };
            if let Err(error) = crate::backup::recover_interrupted_restore(&dir.join(crate::backup::DB_FILE), &dir.join(crate::backup::BACKUP_DIR)) {
                return Err(abort_startup_after_failed_recovery(error.code, &app.config().identifier));
            }
            // Fenêtre impossible à créer (`window-failed`) : même boîte système, puis arrêt (sans elle l'app tournerait sans interface).
            if create_main_window(app.handle()).is_err() {
                return Err(abort_startup_after_failed_recovery("window-failed", &app.config().identifier));
            }
            app.manage(QuitGate::default());
            app.manage(TraySyncState::default());
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
