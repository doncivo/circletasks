//! CircleTasks (SEC-01, bloquant B7) : fermeture du plugin SQL.
//!
//! Avant ce module, la WebView (donc toute dépendance npm compromise du build du front) pouvait demander au plugin d'ouvrir ou de
//! créer un fichier n'importe où (`load` avec un chemin absolu ou `..`), d'attacher une autre base (`ATTACH`), de copier la base
//! (`VACUUM INTO`) ou de changer les réglages dangereux de SQLite (`PRAGMA writable_schema`, ...). Les permissions de Tauri sont par
//! commande, sans portée sur les arguments : la défense est donc ici, dans le code vendu. Quatre couches, de la plus sûre à la plus
//! fragile :
//!
//! 1. **URL** : `load` n'accepte que la chaîne exacte [`ALLOWED_URL`] ([`validate_db_url`]), avant toute création de fichier.
//! 2. **Limite** : `SQLITE_LIMIT_ATTACHED = 0` sur chaque connexion du pool (aucune base ne peut être attachée, ni par `ATTACH`, ni
//!    par `VACUUM INTO`, qui attache sa cible).
//! 3. **Autorisateur SQLite** (`sqlite3_set_authorizer`) : refuse `ATTACH`, `DETACH`, les fonctions `load_extension`,
//!    `fts3_tokenizer`, `readfile`, `writefile`, `edit`, toute table virtuelle hors `fts5`, et tout `PRAGMA` hors liste blanche
//!    ([`decide`]). C'est SQLite qui décide, sur l'instruction analysée : aucun contournement par la forme du texte.
//! 4. **Filtre lexical `VACUUM`** ([`mentions_vacuum`]) : SQLite n'a **aucun code d'autorisation pour `VACUUM`** (les 33 codes de
//!    `sqlite3_set_authorizer`, de `SQLITE_CREATE_INDEX` à `SQLITE_RECURSIVE`, n'en contiennent pas ; https://sqlite.org/c3ref/c_alter_table.html),
//!    l'autorisateur ne le voit donc pas. Le mot est refusé à toute position hors commentaire, littéral et identifiant entre
//!    guillemets. La couche 2 le bloque déjà pour `VACUUM INTO` (qui attache sa cible) : le filtre est une ceinture de plus.
//!
//! Un refus est une erreur explicite [`Error::Refused`] de **code stable** (`url`, `attach`, `vacuum`, `pragma`, `function`, `vtable`,
//! `auth`), jamais le texte SQL ni l'URL, et il est signalé au crochet [`set_refusal_hook`] (le programme l'écrit au journal sous
//! `sql-refused`). Les sauvegardes de l'application (`backup.rs`) utilisent `rusqlite` sur des connexions séparées, hors de ce pool :
//! elles ne sont pas concernées.

use std::sync::OnceLock;

use crate::Error;

/// Seule valeur acceptée par `load` (sensible à la casse, aucun suffixe, aucun paramètre).
pub const ALLOWED_URL: &str = "sqlite:circletasks.db";

/// Crochet appelé à chaque refus avec son code stable (le programme principal y écrit `applog::write("sql-refused", code)`).
static REFUSAL_HOOK: OnceLock<fn(&'static str)> = OnceLock::new();

/// Enregistre le crochet des refus (une seule fois par processus ; les appels suivants sont sans effet).
pub fn set_refusal_hook(hook: fn(&'static str)) {
    let _ = REFUSAL_HOOK.set(hook);
}

/// Construit le refus de code `code` et le signale au crochet. Seul point de création de [`Error::Refused`] : aucun refus n'est silencieux.
pub(crate) fn refuse(code: &'static str) -> Error {
    if let Some(hook) = REFUSAL_HOOK.get() {
        hook(code);
    }
    Error::Refused(code)
}

/// Couche 1 : `load` n'accepte que [`ALLOWED_URL`]. Aucune lecture de chemin, création de dossier ou de fichier avant ce contrôle.
pub(crate) fn validate_db_url(url: &str) -> Result<(), Error> {
    if url == ALLOWED_URL {
        Ok(())
    } else {
        Err(refuse("url"))
    }
}

/// Couche 4 : refuse toute instruction qui contient le mot `VACUUM` (à n'importe quelle position, donc aussi après un `;`), ainsi que,
/// pour qu'un objet de schéma persistant n'en porte jamais, une fonction refusée (`load_extension`, `fts3_tokenizer`, `readfile`,
/// `writefile`, `edit(`) ou un `pragma_<nom>` hors liste blanche. Ces derniers sont aussi refusés par l'autorisateur, mais seulement à
/// l'exécution : le corps d'un `CREATE TRIGGER` ou d'une `CREATE VIEW` n'y est pas soumis à la création, et l'objet bloquerait ensuite
/// toutes les écritures de sa table (audit M1).
pub(crate) fn check_statement(sql: &str) -> Result<(), Error> {
    let words = sql_words(sql);
    if words.iter().any(|(w, _)| w.eq_ignore_ascii_case("vacuum")) {
        return Err(refuse("vacuum"));
    }
    for (word, call) in &words {
        let lower = word.to_ascii_lowercase();
        if matches!(lower.as_str(), "load_extension" | "fts3_tokenizer" | "readfile" | "writefile") || (lower == "edit" && *call) {
            return Err(refuse("function"));
        }
        #[cfg(feature = "sqlite")]
        if let Some(pragma) = lower.strip_prefix("pragma_")
            && !PRAGMA_WHITELIST.contains(&pragma)
        {
            return Err(refuse("pragma"));
        }
    }
    Ok(())
}

/// Le mot `VACUUM` (casse ignorée) apparaît-il comme mot du langage SQL ? (voir [`sql_words`])
#[cfg(test)]
pub(crate) fn mentions_vacuum(sql: &str) -> bool {
    sql_words(sql).iter().any(|(w, _)| w.eq_ignore_ascii_case("vacuum"))
}

/// Mots du langage SQL de `sql`, avec « suivi d'une parenthèse ouvrante » (appel de fonction). Les commentaires `--` et `/* */`, les
/// littéraux `'...'` et les identifiants `"..."`, `` `...` `` et `[...]` sont ignorés : `SELECT 'vacuum'` et `vacuum_count` ne sont pas
/// des faux refus. Un littéral ou un commentaire non terminé s'étend jusqu'à la fin du texte, comme dans SQLite.
fn sql_words(sql: &str) -> Vec<(String, bool)> {
    let chars: Vec<char> = sql.chars().collect();
    let skip_to = |from: usize, close: &[char]| -> usize {
        let mut i = from;
        while i < chars.len() {
            if chars[i..].starts_with(close) {
                return i + close.len();
            }
            i += 1;
        }
        chars.len()
    };
    let is_word = |c: char| c.is_alphanumeric() || c == '_' || c == '$' || !c.is_ascii();
    let mut words = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '-' && chars.get(i + 1) == Some(&'-') {
            i = skip_to(i + 2, &['\n']);
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            i = skip_to(i + 2, &['*', '/']);
        } else if c == '\'' || c == '"' || c == '`' {
            i = skip_to(i + 1, &[c]);
        } else if c == '[' {
            i = skip_to(i + 1, &[']']);
        } else if is_word(c) || ((c == ':' || c == '@') && chars.get(i + 1).is_some_and(|n| is_word(*n))) {
            // Un paramètre nommé (`:vacuum`, `@vacuum`) garde son préfixe : ce n'est pas le mot-clé.
            let start = i;
            i += 1;
            while i < chars.len() && is_word(chars[i]) {
                i += 1;
            }
            let call = chars[i..].iter().find(|c| !c.is_whitespace()) == Some(&'(');
            words.push((chars[start..i].iter().collect::<String>(), call));
        } else {
            i += 1;
        }
    }
    words
}

// ------------------------------------------------------------------------------------------------------------------------------
// Couches 2 et 3 : limite d'attachement et autorisateur SQLite (sqlite seulement)
// ------------------------------------------------------------------------------------------------------------------------------

/// Raison du dernier refus de l'autorisateur (0 : aucun), lue par le plugin quand SQLite répond `not authorized`.
#[cfg(feature = "sqlite")]
pub(crate) const REASON_ATTACH: u8 = 1;
#[cfg(feature = "sqlite")]
pub(crate) const REASON_PRAGMA: u8 = 2;
#[cfg(feature = "sqlite")]
pub(crate) const REASON_FUNCTION: u8 = 3;
#[cfg(feature = "sqlite")]
pub(crate) const REASON_VTABLE: u8 = 4;

/// LISTE BLANCHE UNIQUE des pragmas (noms en minuscules) : lue aussi par `tests/unit/sqlPragmaScan.test.ts`, qui vérifie que le code du front
/// (`src/**`) n'émet aucun autre pragma. Les arguments admis sont décidés dans [`pragma_allowed`].
#[cfg(feature = "sqlite")]
pub(crate) const PRAGMA_WHITELIST: &[&str] = &["foreign_keys", "journal_mode", "wal_checkpoint", "data_version", "quick_check"];

/// Pragmas autorisés, avec leur argument : `data_version` (lecture seule, émis par fts5), `quick_check` (lecture seule, émis par `ALTER TABLE ADD COLUMN ... CHECK`), `foreign_keys` (lecture, `ON` ou `1`), `journal_mode` (lecture ou `WAL`), `wal_checkpoint`
/// (tout argument). Tout autre pragma est refusé, y compris en lecture : un pragma futur reste refusé tant qu'il n'est pas listé ici.
#[cfg(feature = "sqlite")]
fn pragma_allowed(name: &str, arg: Option<&str>) -> bool {
    let name = name.to_ascii_lowercase();
    if !PRAGMA_WHITELIST.contains(&name.as_str()) {
        return false;
    }
    let arg = arg.map(|a| a.trim().to_ascii_lowercase());
    match name.as_str() {
        "foreign_keys" => matches!(arg.as_deref(), None | Some("on" | "1")),
        "journal_mode" => matches!(arg.as_deref(), None | Some("wal")),
        "wal_checkpoint" => true,
        // Lecture seule, émise par le module fts5 lui-même (SEC-01 : repérée à l'exécution de la migration 0011), jamais par le front.
        "data_version" => arg.is_none(),
        // Lecture seule, émis par SQLite lui-même pour `ALTER TABLE ... ADD COLUMN ... CHECK` (`pragma_quick_check(table, main)`, migration 0018).
        "quick_check" => arg.is_some(),
        _ => false,
    }
}

/// Fonctions SQL refusées (lecture et écriture de fichiers, chargement de code, remplacement de tokenizer).
#[cfg(feature = "sqlite")]
fn function_refused(name: &str) -> bool {
    ["load_extension", "fts3_tokenizer", "readfile", "writefile", "edit"].iter().any(|f| name.eq_ignore_ascii_case(f))
}

/// Décision de l'autorisateur pour une action SQLite (`action` : code `SQLITE_*` ; `a1` et `a2` : premier et deuxième argument de
/// l'action, voir https://sqlite.org/c3ref/c_alter_table.html). `Some(raison)` refuse, `None` laisse passer.
#[cfg(feature = "sqlite")]
pub(crate) fn decide(action: i32, a1: Option<&str>, a2: Option<&str>) -> Option<u8> {
    use libsqlite3_sys as ffi;
    match action {
        ffi::SQLITE_ATTACH | ffi::SQLITE_DETACH => Some(REASON_ATTACH),
        // a2 : nom de la fonction. (SQLite n'appelle l'autorisateur que pour une fonction qui existe.)
        ffi::SQLITE_FUNCTION => a2.filter(|f| function_refused(f)).map(|_| REASON_FUNCTION),
        // a2 : nom du module. Seul `fts5` (index de recherche, migration 0011) est une table virtuelle légitime.
        ffi::SQLITE_CREATE_VTABLE | ffi::SQLITE_DROP_VTABLE => (!a2.is_some_and(|m| m.eq_ignore_ascii_case("fts5"))).then_some(REASON_VTABLE),
        // a1 : nom du pragma, a2 : son argument ou NULL.
        ffi::SQLITE_PRAGMA => (!a1.is_some_and(|name| pragma_allowed(name, a2))).then_some(REASON_PRAGMA),
        _ => None,
    }
}

#[cfg(feature = "sqlite")]
#[cfg(all(test, feature = "sqlite"))]
pub(crate) use sqlite::pending_reason;
#[cfg(feature = "sqlite")]
pub(crate) use sqlite::{clear_reason, forget_pool, harden_pool_options, register_pool, sqlite_error};

#[cfg(feature = "sqlite")]
mod sqlite {
    use std::ffi::{CStr, c_char, c_int, c_void};
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::sync::{Arc, Mutex};

    use libsqlite3_sys as ffi;
    use sqlx::sqlite::{SqlitePoolOptions, SqlitePool};

    use super::{REASON_ATTACH, REASON_FUNCTION, REASON_PRAGMA, REASON_VTABLE, decide, refuse};
    use crate::Error;

    /// Raisons de refus par pool (clé : adresse des options du pool, commune à tous ses clones). Le pool n'a qu'une connexion, mais une
    /// reconnexion de sqlx reprend le même état.
    static POOLS: Mutex<Vec<(usize, Arc<AtomicU8>)>> = Mutex::new(Vec::new());

    fn pools() -> std::sync::MutexGuard<'static, Vec<(usize, Arc<AtomicU8>)>> {
        POOLS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn key(pool: &SqlitePool) -> usize {
        std::ptr::from_ref(pool.options()) as usize
    }

    /// Rattache l'état des refus au pool une fois créé (appelé par `open_sqlite_pool`).
    pub(crate) fn register_pool(pool: &SqlitePool, state: &Arc<AtomicU8>) {
        let key = key(pool);
        let mut pools = pools();
        pools.retain(|(k, _)| *k != key);
        pools.push((key, Arc::clone(state)));
    }

    /// Raison de refus en attente pour ce pool (0 : aucune). Tests seulement.
    #[cfg(test)]
    pub(crate) fn pending_reason(pool: &SqlitePool) -> u8 {
        pools().iter().find(|(k, _)| *k == key(pool)).map_or(0, |(_, s)| s.load(Ordering::SeqCst))
    }

    /// Remet à zéro la raison de refus en attente, avant chaque `execute` et `select` : une raison notée par un pragma interne d'une
    /// instruction réussie ne doit pas classer un refus ultérieur (audit M4).
    pub(crate) fn clear_reason(pool: &SqlitePool) {
        if let Some((_, state)) = pools().iter().find(|(k, _)| *k == key(pool)) {
            state.store(0, Ordering::SeqCst);
        }
    }

    /// Retire l'état d'un pool fermé.
    pub(crate) fn forget_pool(pool: &SqlitePool) {
        let key = key(pool);
        pools().retain(|(k, _)| *k != key);
    }

    /// Erreur de sqlx pour un appel sur `pool` : « not authorized » (refus de l'autorisateur) devient [`Error::Refused`] du code de la
    /// dernière raison enregistrée (`auth` si aucune), signalé au crochet ; toute autre erreur reste [`Error::Sql`].
    pub(crate) fn sqlite_error(pool: &SqlitePool, error: sqlx::Error) -> Error {
        if let sqlx::Error::Database(db) = &error
            && (db.code().as_deref() == Some("23") || db.message().starts_with("not authorized"))
        {
            let state = pools().iter().find(|(k, _)| *k == key(pool)).map(|(_, s)| Arc::clone(s));
            let reason = state.map_or(0, |s| s.swap(0, Ordering::SeqCst));
            return refuse(match reason {
                REASON_ATTACH => "attach",
                REASON_PRAGMA => "pragma",
                REASON_FUNCTION => "function",
                REASON_VTABLE => "vtable",
                _ => "auth",
            });
        }
        Error::Sql(error)
    }

    /// Fonction de rappel de SQLite. `user` est le pointeur d'un `AtomicU8` vivant tant que le processus (voir [`harden`]).
    unsafe extern "C" fn authorizer(user: *mut c_void, action: c_int, a1: *const c_char, a2: *const c_char, _a3: *const c_char, _a4: *const c_char) -> c_int {
        // Un panic ne doit jamais traverser la frontière FFI (comportement indéfini en `panic = "unwind"`, build de test et de développement) :
        // il est converti en refus, jamais en autorisation.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let text = |p: *const c_char| -> Option<String> {
                // SAFETY : SQLite passe NULL ou une chaîne C terminée, valide pendant l'appel.
                (!p.is_null()).then(|| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
            };
            match decide(action, text(a1).as_deref(), text(a2).as_deref()) {
                None => ffi::SQLITE_OK,
                Some(reason) => {
                    // SAFETY : `user` vient de `Arc::into_raw` dans `harden`, jamais libéré.
                    unsafe { &*user.cast::<AtomicU8>() }.store(reason, Ordering::SeqCst);
                    ffi::SQLITE_DENY
                }
            }
        }))
        .unwrap_or(ffi::SQLITE_DENY)
    }

    /// Couches 2 et 3 sur une connexion : limite d'attachement à 0 et autorisateur.
    ///
    /// # Safety
    /// `db` doit être le descripteur valide d'une connexion SQLite ouverte, non utilisée en parallèle pendant l'appel.
    unsafe fn harden(db: *mut ffi::sqlite3, state: &Arc<AtomicU8>) -> Result<(), String> {
        // SAFETY : `db` valide (contrat). Limite à 0 : `ATTACH` et `VACUUM INTO` échouent même si l'autorisateur est neutralisé.
        unsafe { ffi::sqlite3_limit(db, ffi::SQLITE_LIMIT_ATTACHED, 0) };
        // Mode défensif (pas d'écriture du schéma ni de corruption volontaire) et schéma non fiable (déclencheurs et vues ne peuvent
        // appeler que des fonctions « innocuous »). SAFETY : `db` valide ; les deux réglages prennent un entier et un pointeur de retour nul.
        for op in [ffi::SQLITE_DBCONFIG_DEFENSIVE, ffi::SQLITE_DBCONFIG_TRUSTED_SCHEMA] {
            let on = c_int::from(op == ffi::SQLITE_DBCONFIG_DEFENSIVE);
            // SAFETY : voir ci-dessus.
            let rc = unsafe { ffi::sqlite3_db_config(db, op, on, std::ptr::null_mut::<c_int>()) };
            if rc != ffi::SQLITE_OK {
                return Err(format!("sqlite3_db_config({op}) a répondu {rc}"));
            }
        }
        // Une part de l'`Arc` est volontairement laissée à l'autorisateur pour la vie du processus (quelques octets par connexion ;
        // le pool recycle sa connexion unique, jamais plus d'une poignée sur toute la vie de l'application).
        let user = Arc::into_raw(Arc::clone(state)).cast_mut().cast::<c_void>();
        // SAFETY : `authorizer` a la signature attendue ; `user` reste valide (part d'`Arc` jamais rendue).
        let rc = unsafe { ffi::sqlite3_set_authorizer(db, Some(authorizer), user) };
        if rc == ffi::SQLITE_OK { Ok(()) } else { Err(format!("sqlite3_set_authorizer a répondu {rc}")) }
    }

    /// Pose les couches 2 et 3 sur chaque connexion que le pool ouvre (après les pragmas de connexion de sqlx : `journal_mode = WAL` et
    /// `foreign_keys = ON`, qui sont donc posés avant l'autorisateur).
    pub(crate) fn harden_pool_options(options: SqlitePoolOptions, state: Arc<AtomicU8>) -> SqlitePoolOptions {
        options.after_connect(move |conn, _meta| {
            let state = Arc::clone(&state);
            Box::pin(async move {
                let mut handle = conn.lock_handle().await?;
                // SAFETY : descripteur de la connexion que `handle` verrouille (le thread de travail de sqlx n'y touche pas pendant ce temps).
                unsafe { harden(handle.as_raw_handle().as_ptr(), &state) }.map_err(|e| sqlx::Error::Configuration(e.into()))
            })
        })
    }
}
