import { expect, type Locator, type Page } from '@playwright/test';
import { startCaldavSim, startGoogleSim, type CaldavSim, type CaldavSimOptions, type GoogleSim, type GoogleSimOptions } from '../../sim';

/** Aides e2e des agendas externes (K-01 à K-04) : simulateurs dédiés à un test, écran Agendas. Aucun compte réel. */

export interface TestSims {
  readonly google: GoogleSim;
  readonly caldav: CaldavSim;
  close(): Promise<void>;
}

/**
 * Démarre un Google et un CalDAV simulés propres au test (port libre) : deux workers ne partagent jamais un état modifiable. Ceux de
 * `globalSetup` (ports fixes) servent seulement de réglage par défaut du serveur de développement.
 */
export async function startTestSims(options: { google?: GoogleSimOptions; caldav?: CaldavSimOptions } = {}): Promise<TestSims> {
  const google = await startGoogleSim(options.google);
  const caldav = await startCaldavSim(options.caldav);
  return { google, caldav, close: async () => void (await Promise.all([google.close(), caldav.close()])) };
}

/** Annonce les simulateurs du test au navigateur AVANT le chargement de la page (lus par `bootstrapApp` en développement seulement). */
export async function attachSims(page: Page, sims: TestSims): Promise<void> {
  await page.addInitScript(
    (config) => {
      (globalThis as { __ctCalendarSims?: unknown }).__ctCalendarSims = config;
    },
    { google: sims.google.baseUrl, caldav: sims.caldav.baseUrl, clientId: sims.google.clientId },
  );
}

/** Ouvre Réglages › Agendas (ligne « Agendas · Rappels Apple »). */
export async function openCalendarsScreen(page: Page): Promise<void> {
  await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  const row = page.getByRole('button', { name: /^Agendas · Rappels Apple :/ });
  const heading = page.getByRole('heading', { name: 'Agendas', exact: true });
  await expect(row.or(heading)).toBeVisible();
  if (await row.isVisible()) await row.click();
  await expect(heading).toBeVisible();
}

/** Carte d'un compte de l'écran Agendas, par son nom de source et son label. */
export const accountCard = (page: Page, provider: 'Google Agenda' | 'iCloud', label: string): Locator => page.getByRole('region', { name: `${provider} · ${label}` });

/** Attend la fin du premier rafraîchissement d'une carte : « Mis à jour … » affiché. */
export async function waitUpdated(card: Locator): Promise<void> {
  await expect(card.getByText(/^Mis à jour/)).toBeVisible();
}
