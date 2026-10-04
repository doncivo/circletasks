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

/// Coffre système : Gestionnaire d'identification Windows (`windows-native`), Trousseau iOS (`apple-native`). Service
/// `fr.circletasks.planner`, compte = `token_ref`. Sur une autre cible (aucune n'est livrée), tout accès rend `Unavailable`.
pub struct SystemVault;

#[cfg(any(windows, target_os = "ios"))]
impl SystemVault {
    fn entry(token_ref: &str) -> Result<keyring::Entry, VaultError> {
        keyring::Entry::new(super::VAULT_SERVICE, token_ref).map_err(|_| VaultError::Unavailable)
    }
}

#[cfg(any(windows, target_os = "ios"))]
impl SecretVault for SystemVault {
    fn set(&self, token_ref: &str, secret: &str) -> Result<(), VaultError> {
        Self::entry(token_ref)?.set_password(secret).map_err(|_| VaultError::Unavailable)
    }

    fn get(&self, token_ref: &str) -> Result<Option<String>, VaultError> {
        match Self::entry(token_ref)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(VaultError::Unavailable),
        }
    }

    fn delete(&self, token_ref: &str) -> Result<(), VaultError> {
        match Self::entry(token_ref)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(VaultError::Unavailable),
        }
    }
}

#[cfg(not(any(windows, target_os = "ios")))]
impl SecretVault for SystemVault {
    fn set(&self, _token_ref: &str, _secret: &str) -> Result<(), VaultError> {
        Err(VaultError::Unavailable)
    }

    fn get(&self, _token_ref: &str) -> Result<Option<String>, VaultError> {
        Err(VaultError::Unavailable)
    }

    fn delete(&self, _token_ref: &str) -> Result<(), VaultError> {
        Err(VaultError::Unavailable)
    }
}
