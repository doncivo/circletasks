import { startCaldavSim, type CaldavSim } from './caldavSim';
import { startGoogleSim, type GoogleSim } from './googleSim';

export * from './caldavFixtures';
export * from './caldavSim';
export * from './googleSim';
export type { InjectedFailure, RunningSim } from './httpSim';

/**
 * Démarre les deux simulateurs (Vitest `beforeAll`, ou `globalSetup` Playwright). Ports fixes possibles pour Playwright, dont le
 * navigateur de dev doit connaître les URL (variables `VITE_CT_GOOGLE_SIM` / `VITE_CT_CALDAV_SIM`, à câbler par calendar-integration).
 */
export async function startCalendarSims(ports: { readonly google?: number; readonly caldav?: number } = {}): Promise<{ google: GoogleSim; caldav: CaldavSim; close(): Promise<void> }> {
  const google = await startGoogleSim(ports.google === undefined ? {} : { port: ports.google });
  const caldav = await startCaldavSim(ports.caldav === undefined ? {} : { port: ports.caldav });
  return { google, caldav, close: async () => void (await Promise.all([google.close(), caldav.close()])) };
}
