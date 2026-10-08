//! Confirmation native de l'iPhone (ADR 0011 §23 point 3 ; Y-IOS-02 critères 11 à 13) : `IosConsentUi` implémente `ConsentUi` par le même
//! transport que `BookmarkFs` (plugin folder-bookmark) :
//!
//! - `owner_ready` : l'app est au premier plan (`appState` vaut `active`) ; une erreur vaut « non » (`not-foreground`, aucune alerte) ;
//! - `ask` : commande Swift `confirm({ title, message, confirm, cancel })` → `{ confirmed }` ; `UIAlertController`, « Annuler » en style
//!   `.cancel` et action préférée. Textes **lus par Rust** dans `src/i18n/native/fr.json` (`DialogSpec`), jamais fournis par la WebView ni
//!   écrits en Swift. « Annuler », fermeture (passage en arrière-plan), erreur ou rejet du plugin : **refus** (échec fermé).
//!
//! `ConsentGate` est inchangé (compteurs, blocage, verrou) : la même suite de tests passe avec l'interface de Windows et celle-ci.

use std::sync::Arc;

use serde_json::{json, Value};

use super::bookmark::BookmarkTransport;
use super::consent::{ConsentUi, DialogSpec, IDCANCEL, ID_CONFIRM};
use super::log;

/// Confirmation par `UIAlertController` (plugin folder-bookmark).
pub struct IosConsentUi {
    transport: Arc<dyn BookmarkTransport>,
}

impl IosConsentUi {
    pub fn new(transport: Arc<dyn BookmarkTransport>) -> Self {
        Self { transport }
    }
}

/// Arguments de `confirm` : titre = consigne, message = explication (détail compris), libellés des deux boutons de la boîte.
pub fn confirm_args(spec: &DialogSpec) -> Value {
    let label = |id: i32| spec.buttons.iter().find(|(button, _)| *button == id).map(|(_, text)| text.clone()).unwrap_or_default();
    json!({ "title": spec.texts.instruction, "message": spec.texts.content, "confirm": label(ID_CONFIRM), "cancel": label(IDCANCEL) })
}

impl ConsentUi for IosConsentUi {
    fn owner_ready(&self, _owner: isize) -> bool {
        match self.transport.call("appState", json!({})) {
            Ok(value) => value.get("state").and_then(Value::as_str) == Some("active"),
            Err(code) => {
                log::event("consent-app-state-failed", if code == "not-foreground" { "not-foreground" } else { "io" });
                false
            }
        }
    }

    fn ask(&self, spec: &DialogSpec) -> bool {
        match self.transport.call("confirm", confirm_args(spec)) {
            Ok(value) => value.get("confirmed").and_then(Value::as_bool) == Some(true),
            Err(code) => {
                log::event("consent-alert-failed", if code == "not-foreground" { "not-foreground" } else { "io" });
                false
            }
        }
    }
}
