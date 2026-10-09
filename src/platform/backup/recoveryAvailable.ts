/**
 * I-06 (revue M3) : condition UNIQUE de disponibilité de la restauration depuis l'écran d'échec du démarrage, lue par `openStartupRecovery`
 * et par l'écran (sans charger le service : bundle de départ). App installée sur PC ou iPhone ; en développement, faux posé par un e2e
 * (`globalThis.__ctStartupRecovery`).
 */
export function startupRecoveryAvailable(runtime: 'tauri' | 'web', os: 'windows' | 'ios' | 'other'): boolean {
  if (import.meta.env.DEV && (globalThis as { __ctStartupRecovery?: unknown }).__ctStartupRecovery) return true;
  return runtime === 'tauri' && os !== 'other';
}
