//! Coffre des secrets d'agendas (ADR 0008). Production : crate `keyring` 3 (Gestionnaire
//! d'identification Windows, Trousseau iOS), service `fr.circletasks.planner`, compte = `token_ref`.
//! Tests : `MemoryVault`. Un secret n'est jamais journalisé ni renvoyé à la WebView.

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultError {
    /// Coffre système indisponible ou accès refusé (code `vault-unavailable`).
    Unavailable,
}

pub trait SecretVault: Send + Sync {
    fn set(&self, token_ref: &str, secret: &str) -> Result<(), VaultError>;
    /// `Ok(None)` : aucune entrée sur CET appareil (K-01 D1, compte « à reconnecter »).
    fn get(&self, token_ref: &str) -> Result<Option<String>, VaultError>;
    /// Idempotent.
    fn delete(&self, token_ref: &str) -> Result<(), VaultError>;
}

/// Coffre en mémoire pour cargo test (même contrat que le coffre système).
#[derive(Default)]
pub struct MemoryVault {
    entries: Mutex<HashMap<String, String>>,
}

impl SecretVault for MemoryVault {
    fn set(&self, token_ref: &str, secret: &str) -> Result<(), VaultError> {
        self.entries.lock().map_err(|_| VaultError::Unavailable)?.insert(token_ref.to_owned(), secret.to_owned());
        Ok(())
    }

    fn get(&self, token_ref: &str) -> Result<Option<String>, VaultError> {
        Ok(self.entries.lock().map_err(|_| VaultError::Unavailable)?.get(token_ref).cloned())
    }

    fn delete(&self, token_ref: &str) -> Result<(), VaultError> {
        self.entries.lock().map_err(|_| VaultError::Unavailable)?.remove(token_ref);
        Ok(())
    }
}
