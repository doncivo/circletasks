//! Validation du raccourci global « Capture rapide » (D-04, critères 6 et 11).

use circletasks_lib::shortcut::{parse_chord, ShortcutError, DEFAULT_QUICK_CAPTURE};

#[test]
fn default_combination_is_valid_and_canonical() {
    let chord = parse_chord(DEFAULT_QUICK_CAPTURE).expect("défaut valide");
    assert!(chord.ctrl && chord.alt && !chord.shift);
    assert_eq!(chord.canonical(), "Ctrl+Alt+Space");
}

#[test]
fn accepts_common_combinations() {
    for ok in ["Ctrl+Shift+Space", "Ctrl+Alt+Q", "Alt+F9", "Ctrl+1", "Ctrl+Alt+ArrowUp", "Alt+Shift+K"] {
        assert!(parse_chord(ok).is_ok(), "{ok} devrait être accepté");
    }
}

#[test]
fn canonical_form_orders_modifiers() {
    assert_eq!(parse_chord("Shift+Alt+Ctrl+K").map(|c| c.canonical()), Ok("Ctrl+Alt+Shift+K".to_owned()));
}

#[test]
fn rejects_bad_syntax() {
    for bad in ["", "+", "Ctrl+", "Ctrl+Alt+", "Ctrl+Alt+Spacebar", "Ctrl+Ctrl+K", "Ctrl+k", "Ctrl+F25", "Ctrl+F0", "Foo+K", "Ctrl+Alt+AB"] {
        assert_eq!(parse_chord(bad), Err(ShortcutError::Syntax), "{bad:?}");
    }
}

#[test]
fn requires_ctrl_or_alt() {
    for bad in ["Space", "K", "Shift+K", "Shift+F5", "F5"] {
        assert_eq!(parse_chord(bad), Err(ShortcutError::NoModifier), "{bad:?}");
    }
}

#[test]
fn rejects_windows_key() {
    for bad in ["Super+K", "Ctrl+Super+K", "Win+Space", "Meta+K", "Cmd+K", "Ctrl+Windows"] {
        assert_eq!(parse_chord(bad), Err(ShortcutError::WindowsKey), "{bad:?}");
    }
}

#[test]
fn rejects_reserved_combinations() {
    for bad in ["Ctrl+Alt+Delete", "Alt+F4", "Alt+Tab", "Ctrl+Escape", "Ctrl+Shift+Escape", "Alt+Space", "Ctrl+C", "Ctrl+V", "Ctrl+Z"] {
        assert_eq!(parse_chord(bad), Err(ShortcutError::Reserved), "{bad:?}");
    }
}

#[test]
fn error_codes_are_stable() {
    let codes: Vec<_> = [
        ShortcutError::Syntax,
        ShortcutError::NoModifier,
        ShortcutError::WindowsKey,
        ShortcutError::Reserved,
        ShortcutError::InUse,
        ShortcutError::Unavailable,
    ]
    .iter()
    .map(|e| e.code())
    .collect();
    assert_eq!(
        codes,
        ["shortcut-syntax", "shortcut-no-modifier", "shortcut-windows-key", "shortcut-reserved", "shortcut-in-use", "shortcut-unavailable"]
    );
}
