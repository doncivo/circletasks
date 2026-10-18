//! CircleTasks (SEC-01, bloquant B7) : fermeture du plugin SQL. Bouchon du commit « rouge » : accepte tout.

use crate::Error;

/// Bouchon : accepte toute URL (le correctif la remplace par la liste blanche `sqlite:circletasks.db`).
pub(crate) fn validate_db_url(_url: &str) -> Result<(), Error> {
    Ok(())
}
