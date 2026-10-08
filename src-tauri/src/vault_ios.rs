//! Clé de synchronisation au Trousseau iOS (ADR 0011 section 2.2 et §23 point 1, audit H3 ; Y-08 critère 17, Y-IOS-02 critères 1 à 4).
//!
//! `keyring` (`apple-native`) ne permet pas de fixer l'accessibilité ni la synchronisation iCloud d'un élément : la clé de synchro passe
//! donc par `security-framework` 3 directement (`keyring` ne sert qu'aux jetons d'agenda, `vault.rs`).
//!
//! - Comptes acceptés : **exactement** `circletasks.sync.key.v1` et `circletasks.sync.key.next` (tout autre : `Unavailable`).
//! - Élément `kSecClassGenericPassword`, service `fr.circletasks.planner`, `AccessibleWhenUnlockedThisDeviceOnly` sans drapeau de présence,
//!   `kSecAttrSynchronizable = false` à l'écriture **et** dans chaque requête.
//! - Écriture : suppression puis ajout, puis **relecture** : une valeur relue différente supprime l'élément et rend `Unavailable` (jamais
//!   une clé à moitié écrite).
//! - Lecture : `errSecItemNotFound` → absent ; **toute autre erreur** (dont `errSecInteractionNotAllowed`, iPhone verrouillé) →
//!   `Unavailable`, jamais « absent » : aucune clé n'est recréée en silence.
//! - `CachedVault` : la clé lue reste en mémoire (le Trousseau n'est relu qu'au premier usage et après une écriture ou une suppression faite
//!   par l'app) : le cycle du passage en arrière-plan, écran verrouillé, garde la clé déjà chargée.
//!
//! La logique (comptes, codes, écriture vérifiée, cache) est compilée sur toutes les cibles et testée sous Windows avec un faux Trousseau
//! (`KeychainOps`) ; l'accès réel n'existe que sous `cfg(target_os = "ios")`, compilé par `build-ios.yml`.

use std::collections::HashMap;
use std::sync::Mutex;

use zeroize::Zeroizing;

use crate::vault::{SecretVault, VaultError};

/// Préfixe des comptes de clé de synchronisation.
pub const SYNC_KEY_ACCOUNT_PREFIX: &str = "circletasks.sync.key.";
/// Les deux seuls comptes acceptés (clé courante, nouvelle clé d'une réinitialisation, Y-11).
pub const SYNC_KEY_ACCOUNTS: [&str; 2] = ["circletasks.sync.key.v1", "circletasks.sync.key.next"];

/// `errSecItemNotFound`.
pub const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
/// `errSecInteractionNotAllowed` (appareil verrouillé, élément `WhenUnlocked`).
pub const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;

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

/// Compte accepté par le coffre iOS de la clé : exactement l'un des deux comptes de `SYNC_KEY_ACCOUNTS`.
pub fn is_sync_key_account(account: &str) -> bool {
    SYNC_KEY_ACCOUNTS.contains(&account)
}

/// Lecture : `errSecItemNotFound` → absent (`Ok(None)`) ; toute autre erreur → `Unavailable` (jamais « absent »).
pub fn read_outcome(code: i32) -> Result<Option<Vec<u8>>, VaultError> {
    if code == ERR_SEC_ITEM_NOT_FOUND {
        Ok(None)
    } else {
        Err(VaultError::Unavailable)
    }
}

/// Opérations élémentaires du Trousseau pour un compte de clé (attributs de `sync_key_attributes()` appliqués par l'implémentation) ;
/// erreur : le code `OSStatus`.
pub trait KeychainOps: Send + Sync {
    fn add(&self, account: &str, secret: &[u8]) -> Result<(), i32>;
    fn copy(&self, account: &str) -> Result<Vec<u8>, i32>;
    fn delete(&self, account: &str) -> Result<(), i32>;
}

/// `set` vérifié : compte contrôlé, suppression puis ajout, relecture identique exigée (sinon élément supprimé, `Unavailable`).
pub fn keychain_set(ops: &dyn KeychainOps, account: &str, secret: &str) -> Result<(), VaultError> {
    if !is_sync_key_account(account) {
        return Err(VaultError::Unavailable);
    }
    keychain_delete(ops, account)?;
    ops.add(account, secret.as_bytes()).map_err(|_| VaultError::Unavailable)?;
    let reread = ops.copy(account).map(Zeroizing::new);
    let same = matches!(&reread, Ok(bytes) if bytes.as_slice() == secret.as_bytes());
    if !same {
        // Jamais une clé à moitié écrite : l'élément est retiré (un échec de suppression ne change rien à l'issue).
        let _ = ops.delete(account);
        crate::sync::log::event("keychain-reread-mismatch", account);
        return Err(VaultError::Unavailable);
    }
    Ok(())
}

/// `get` : compte contrôlé ; absent seulement pour `errSecItemNotFound`.
pub fn keychain_get(ops: &dyn KeychainOps, account: &str) -> Result<Option<String>, VaultError> {
    if !is_sync_key_account(account) {
        return Err(VaultError::Unavailable);
    }
    match ops.copy(account) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| VaultError::Unavailable),
        Err(code) => read_outcome(code).map(|_| None),
    }
}

/// `delete` idempotent : `errSecItemNotFound` n'est pas une erreur.
pub fn keychain_delete(ops: &dyn KeychainOps, account: &str) -> Result<(), VaultError> {
    if !is_sync_key_account(account) {
        return Err(VaultError::Unavailable);
    }
    match ops.delete(account) {
        Ok(()) => Ok(()),
        Err(code) if code == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        Err(_) => Err(VaultError::Unavailable),
    }
}

/// Coffre dont les lectures réussies restent en mémoire (§23 point 1) : le Trousseau n'est relu qu'au premier usage et après une écriture
/// ou une suppression faite par l'app ; une erreur n'est jamais gardée (relue à l'appel suivant). Valeurs effacées de la mémoire à leur
/// remplacement et à la destruction.
pub struct CachedVault {
    inner: Box<dyn SecretVault>,
    cache: Mutex<HashMap<String, Option<Zeroizing<String>>>>,
}

impl CachedVault {
    pub fn new(inner: Box<dyn SecretVault>) -> Self {
        Self { inner, cache: Mutex::new(HashMap::new()) }
    }

    fn remember(&self, account: &str, value: Option<Zeroizing<String>>) {
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).insert(account.to_owned(), value);
    }

    fn forget(&self, account: &str) {
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).remove(account);
    }
}

impl SecretVault for CachedVault {
    fn set(&self, account: &str, secret: &str) -> Result<(), VaultError> {
        self.forget(account);
        self.inner.set(account, secret)?;
        self.remember(account, Some(Zeroizing::new(secret.to_owned())));
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
        if let Some(cached) = self.cache.lock().unwrap_or_else(|e| e.into_inner()).get(account) {
            return Ok(cached.as_ref().map(|value| value.as_str().to_owned()));
        }
        let value = self.inner.get(account)?;
        self.remember(account, value.clone().map(Zeroizing::new));
        Ok(value)
    }

    fn delete(&self, account: &str) -> Result<(), VaultError> {
        self.forget(account);
        self.inner.delete(account)?;
        self.remember(account, None);
        Ok(())
    }

    fn contains(&self, account: &str) -> Result<bool, VaultError> {
        Ok(self.get(account)?.map(Zeroizing::new).is_some())
    }
}

#[cfg(target_os = "ios")]
mod keychain {
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{delete_generic_password_options, generic_password, set_generic_password_options, PasswordOptions};

    use super::{keychain_delete, keychain_get, keychain_set, sync_key_attributes, KeychainOps};
    use crate::vault::{SecretVault, VaultError};

    /// Requête : service, compte, magasin non synchronisé seulement (`kSecAttrSynchronizable = false` dans chaque requête).
    fn query(account: &str) -> PasswordOptions {
        let mut options = PasswordOptions::new_generic_password(sync_key_attributes().service, account);
        options.set_access_synchronized(Some(sync_key_attributes().synchronizable));
        options
    }

    /// Trousseau réel (`security-framework`).
    struct Keychain;

    impl KeychainOps for Keychain {
        fn add(&self, account: &str, secret: &[u8]) -> Result<(), i32> {
            let access = SecAccessControl::create_with_protection(Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly), 0).map_err(|e| e.code())?;
            let mut options = query(account);
            options.set_access_control(access);
            set_generic_password_options(secret, options).map_err(|e| e.code())
        }

        fn copy(&self, account: &str) -> Result<Vec<u8>, i32> {
            generic_password(query(account)).map_err(|e| e.code())
        }

        fn delete(&self, account: &str) -> Result<(), i32> {
            delete_generic_password_options(query(account)).map_err(|e| e.code())
        }
    }

    /// Coffre iOS de la clé de synchronisation.
    pub struct IosSyncKeyVault;

    impl SecretVault for IosSyncKeyVault {
        fn set(&self, account: &str, secret: &str) -> Result<(), VaultError> {
            keychain_set(&Keychain, account, secret)
        }

        fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
            keychain_get(&Keychain, account)
        }

        fn delete(&self, account: &str) -> Result<(), VaultError> {
            keychain_delete(&Keychain, account)
        }
    }
}

#[cfg(target_os = "ios")]
pub use keychain::IosSyncKeyVault;
