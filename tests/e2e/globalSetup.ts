import { startCalendarSims } from '../sim';
import { E2E_SIM_PORTS } from '../sim/ports';

/**
 * Lance les simulateurs Google et CalDAV (K-01 à K-03, ADR 0008) sur des ports fixes avant tous les tests, et les arrête à la fin :
 * le navigateur de développement les atteint par VITE_CT_GOOGLE_SIM / VITE_CT_CALDAV_SIM (playwright.config.ts). Aucun serveur ne reste
 * lancé après la suite : la fonction renvoyée les ferme.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const sims = await startCalendarSims(E2E_SIM_PORTS);
  return () => sims.close();
}
