/**
 * Revue I1 (P-04-iOS) : « Mettre les fichiers en conflit de côté » (commande Rust `backup_set_aside_conflicts`, capability
 * `backups-ios.json`) : déplace dans `backups/` ce qui empêche la récupération (rien n'est supprimé), récupère et rend l'état de la porte.
 */
export type RecoveryRetryOutcome = { readonly state: 'ready' } | { readonly state: 'failed' | 'pending'; readonly code: string };

export async function setAsideRecoveryConflicts(): Promise<RecoveryRetryOutcome> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const status = await invoke<{ state: 'ready' | 'failed' | 'pending'; code: string | null }>('backup_set_aside_conflicts');
    return status.state === 'ready' ? { state: 'ready' } : { state: status.state, code: status.code ?? 'unknown' };
  } catch {
    return { state: 'failed', code: 'status-unavailable' };
  }
}

/** Issue d'un nouvel essai du marqueur de restauration (revue I2). */
export type MarkerRetryOutcome = { readonly marker: 'written' | 'not-configured' } | { readonly marker: 'failed'; readonly code: string };

/** « Réessayer » du marqueur non écrit (commande Rust `backup_restore_marker_write`, PC et iPhone) ; navigateur : `unavailable`. */
export async function writeRestoreMarker(backup: string): Promise<MarkerRetryOutcome> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const outcome = await invoke<{ marker: string; code: string | null }>('backup_restore_marker_write', { backup });
    if (outcome.marker === 'written' || outcome.marker === 'not-configured') return { marker: outcome.marker };
    return { marker: 'failed', code: outcome.code ?? 'unknown' };
  } catch {
    return { marker: 'failed', code: 'unavailable' };
  }
}
