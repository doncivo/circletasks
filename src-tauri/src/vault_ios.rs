//! Clé de synchronisation au Trousseau iOS (ADR 0011 section 2.2, audit H3 ; Y-08 critère 17). Contrat de l'ordre 4, compilé pour
//! iOS par la CI (`.github/workflows/build-ios.yml`), vérifié sur l'iPhone à l'ordre 5.
//!
//! `keyring` (`apple-native`) ne permet pas de fixer l'accessibilité ni la synchronisation iCloud d'un élément : la clé de synchro
//! passe donc par `security-framework` directement. Toute entrée `circletasks.sync.key.*` (dont `.next`, transition de Y-11) reçoit
//! les attributs de `sync_key_attributes()` ; aucun autre compte n'est accepté (les jetons d'agenda restent sur `keyring`).
//!
//! Les constantes et le contrôle des comptes sont compilés sur toutes les cibles (test `cargo test` sur PC) ; l'accès au Trousseau
//! n'existe que sous `cfg(target_os = "ios")`.

/// Préfixe des comptes de clé de synchronisation.
pub const SYNC_KEY_ACCOUNT_PREFIX: &str = "circletasks.sync.key.";

/// Attributs appliqués à toute écriture d'une clé de synchronisation au Trousseau.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncKeyAttributes {
    /// `kSecAttrAccessible` : lisible seulement appareil déverrouillé, jamais restaurée sur un autre appareil.
    pub accessible: &'static str,
    /// `kSecAttrSynchronizable` : jamais dans le Trousseau iCloud.
    pub synchronizable: bool,
    /// Service de l'élément (identique au coffre des agendas).
    pub service: &'static str,
}

/// Attributs de la clé de synchro : `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, `kSecAttrSynchronizable = false`.
pub const fn sync_key_attributes() -> SyncKeyAttributes {
    SyncKeyAttributes { accessible: "kSecAttrAccessibleWhenUnlockedThisDeviceOnly", synchronizable: false, service: crate::vault::VAULT_SERVICE }
}

/// Compte accepté par le coffre iOS de la clé : `circletasks.sync.key.<suffixe>` (suffixe non vide, minuscules, chiffres, `.`).
pub fn is_sync_key_account(account: &str) -> bool {
    account
        .strip_prefix(SYNC_KEY_ACCOUNT_PREFIX)
        .is_some_and(|rest| !rest.is_empty() && rest.len() <= 16 && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.'))
}

#[cfg(target_os = "ios")]
mod keychain {
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{delete_generic_password_options, generic_password, set_generic_password_options, PasswordOptions};

    use super::{is_sync_key_account, sync_key_attributes};
    use crate::vault::{SecretVault, VaultError};

    /// `errSecItemNotFound`.
    const ITEM_NOT_FOUND: i32 = -25300;

    /// Requête de recherche : service, compte, magasin non synchronisé seulement.
    fn query(account: &str) -> PasswordOptions {
        let mut options = PasswordOptions::new_generic_password(sync_key_attributes().service, account);
        options.set_access_synchronized(Some(sync_key_attributes().synchronizable));
        options
    }

    /// Coffre iOS de la clé de synchronisation.
    pub struct IosSyncKeyVault;

    impl SecretVault for IosSyncKeyVault {
        fn set(&self, account: &str, secret: &str) -> Result<(), VaultError> {
            if !is_sync_key_account(account) {
                return Err(VaultError::Unavailable);
            }
            // Suppression puis ajout : les attributs sont toujours ceux de `sync_key_attributes()`, jamais ceux d'un ancien élément.
            self.delete(account)?;
            let access = SecAccessControl::create_with_protection(Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly), 0)
                .map_err(|_| VaultError::Unavailable)?;
            let mut options = query(account);
            options.set_access_control(access);
            set_generic_password_options(secret.as_bytes(), options).map_err(|_| VaultError::Unavailable)
        }

        fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
            if !is_sync_key_account(account) {
                return Err(VaultError::Unavailable);
            }
            match generic_password(query(account)) {
                Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| VaultError::Unavailable),
                Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
                Err(_) => Err(VaultError::Unavailable),
            }
        }

        fn delete(&self, account: &str) -> Result<(), VaultError> {
            if !is_sync_key_account(account) {
                return Err(VaultError::Unavailable);
            }
            match delete_generic_password_options(query(account)) {
                Ok(()) => Ok(()),
                Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
                Err(_) => Err(VaultError::Unavailable),
            }
        }
    }
}

#[cfg(target_os = "ios")]
pub use keychain::IosSyncKeyVault;
