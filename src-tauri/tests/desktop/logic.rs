//! Logique pure de la zone de notification et du démarrage réduit (D-01, D-02).

use circletasks_lib::desktop::{
    fallback_labels, hides_on_close, is_minimized_launch, menu_layout, TrayAction, TrayEntry, TrayLabels, MAIN_WINDOW,
};

fn labels(sync_enabled: bool) -> TrayLabels {
    TrayLabels {
        open: "Ouvrir".into(),
        quick_add: "Ajout".into(),
        sync: "Synchro".into(),
        quit: "Quitter".into(),
        sync_enabled,
    }
}

#[test]
fn menu_order_matches_story() {
    let layout = menu_layout(&labels(false));
    let shape: Vec<_> = layout
        .iter()
        .map(|e| match e {
            TrayEntry::Item { action, .. } => action.id(),
            TrayEntry::Separator => "-",
        })
        .collect();
    assert_eq!(shape, ["open", "quick-add", "sync", "-", "quit"]);
}

#[test]
fn sync_is_greyed_until_enabled() {
    let enabled_of = |l: &TrayLabels| match &menu_layout(l)[2] {
        TrayEntry::Item { enabled, .. } => *enabled,
        TrayEntry::Separator => unreachable!(),
    };
    assert!(!enabled_of(&labels(false)));
    assert!(enabled_of(&labels(true)));
}

#[test]
fn only_sync_can_be_greyed() {
    for entry in menu_layout(&labels(false)) {
        if let TrayEntry::Item { action, enabled, .. } = entry {
            assert_eq!(enabled, action != TrayAction::Sync, "{action:?}");
        }
    }
}

#[test]
fn labels_come_from_the_front() {
    let layout = menu_layout(&labels(true));
    assert_eq!(layout[0], TrayEntry::Item { action: TrayAction::Open, label: "Ouvrir".into(), enabled: true });
    assert_eq!(layout[4], TrayEntry::Item { action: TrayAction::Quit, label: "Quitter".into(), enabled: true });
}

#[test]
fn fallback_labels_are_complete_and_keep_sync_greyed() {
    let fallback = fallback_labels();
    assert!([&fallback.open, &fallback.quick_add, &fallback.sync, &fallback.quit].iter().all(|l| !l.is_empty()));
    assert!(!fallback.sync_enabled);
}

#[test]
fn action_ids_round_trip() {
    for action in [TrayAction::Open, TrayAction::QuickAdd, TrayAction::Sync, TrayAction::Quit] {
        assert_eq!(TrayAction::from_id(action.id()), Some(action));
    }
    assert_eq!(TrayAction::from_id("autre"), None);
}

#[test]
fn minimized_launch_is_read_from_arguments() {
    assert!(is_minimized_launch(["circletasks.exe", "--minimized"]));
    assert!(!is_minimized_launch(["circletasks.exe"]));
    assert!(!is_minimized_launch(["circletasks.exe", "--minimized-not"]));
}

#[test]
fn only_the_main_window_hides_on_close() {
    assert!(hides_on_close(MAIN_WINDOW));
    assert!(!hides_on_close("autre"));
}

#[test]
fn labels_deserialize_from_camel_case() {
    let parsed: TrayLabels =
        serde_json::from_str(r#"{"open":"a","quickAdd":"b","sync":"c","quit":"d","syncEnabled":false}"#).expect("JSON valide");
    assert_eq!(parsed.quick_add, "b");
    assert!(!parsed.sync_enabled);
}
