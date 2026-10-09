//! Appel d'un plugin Swift avec délai (ADR 0015 §3.1).
//!
//! `run_mobile_plugin` attend la réponse sans délai (`rx.recv()`) : une méthode Swift qui ne résout jamais bloquerait pour toujours le fil
//! qui l'appelle. `call_with_deadline` lance l'appel bloquant sur un fil dédié et n'attend que `deadline` : au-delà, l'appelant reçoit
//! `CallError::Timeout` (donc un code visible) au lieu de se figer. Le fil dédié reste bloqué jusqu'à la réponse de Swift ; tout
//! « drapeau occupé » déplacé dans la fermeture n'est donc rendu qu'à ce moment-là (une seconde demande est refusée `busy`, visible).
//!
//! Compilé partout : les plugins Vision et Speech sont testés sous Windows avec un faux transport.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use serde_json::Value;

/// Échec d'un appel de plugin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallError {
    /// Délai dépassé : Swift n'a pas répondu à temps (l'appel peut encore aboutir plus tard, sa réponse est ignorée).
    Timeout,
    /// Code rejeté par le plugin (`failed` si le fil de l'appel s'est interrompu).
    Rejected(String),
}

/// Lance `call` sur un fil dédié et attend sa réponse au plus `deadline`.
pub fn call_with_deadline<F>(call: F, deadline: Duration) -> Result<Value, CallError>
where
    F: FnOnce() -> Result<Value, String> + Send + 'static,
{
    let (sender, receiver) = mpsc::channel();
    let spawned = std::thread::Builder::new().name("ct-plugin-call".to_owned()).spawn(move || {
        // Le destinataire a pu partir (délai dépassé) : la réponse tardive est simplement abandonnée.
        let _ = sender.send(call());
    });
    if spawned.is_err() {
        return Err(CallError::Rejected("failed".to_owned()));
    }
    match receiver.recv_timeout(deadline) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(code)) => Err(CallError::Rejected(code)),
        Err(RecvTimeoutError::Timeout) => Err(CallError::Timeout),
        Err(RecvTimeoutError::Disconnected) => Err(CallError::Rejected("failed".to_owned())),
    }
}

/// Code court d'un rejet pour un message d'erreur ou un journal : forme `a-z` et `-` de 32 signes au plus, sinon `failed`
/// (jamais le texte d'une erreur système, un chemin ou un texte reconnu).
pub fn shaped_code(code: &str) -> &str {
    let shaped = !code.is_empty() && code.len() <= 32 && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'-');
    if shaped {
        code
    } else {
        "failed"
    }
}
