import { startCalendarSims, startSyncFolderSim } from '../sim';
import { E2E_SIM_PORTS, E2E_SYNC_SIM_PORT } from '../sim/ports';

/**
 * Lance les simulateurs Google et CalDAV (K-01 à K-03, ADR 0008) et le simulateur de dossier iCloud (Y-04, parcours 10 à deux pages)
 * sur des ports fixes avant tous les tests, et les arrête à la fin : le navigateur de développement atteint les agendas par
 * VITE_CT_GOOGLE_SIM / VITE_CT_CALDAV_SIM (playwright.config.ts) et le dossier par `globalThis.__ctSyncSim` (tests/e2e/helpers/sync.ts).
 * Aucun serveur ne reste lancé après la suite : la fonction renvoyée les ferme.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const sims = await startCalendarSims(E2E_SIM_PORTS);
  const folder = await startSyncFolderSim(E2E_SYNC_SIM_PORT);
  return async () => {
    await Promise.all([sims.close(), folder.close()]);
  };
}
