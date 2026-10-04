import { expect, type Locator, type Page } from '@playwright/test';

/** Aides e2e de l'onglet Événements (E-01 à E-04), communes aux projets `pc` et `iphone`. */

export const eventsTab = (page: Page): Locator => page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Événements', exact: true });

/** Ouvre l'onglet Événements et attend la liste. */
export async function openEvents(page: Page): Promise<void> {
  await eventsTab(page).click();
  await expect(page.locator('.ct-events')).toBeVisible();
}

/** Rouvre l'onglet après des insertions en base (passe par Aujourd'hui : l'écran se recharge à son ouverture). */
export async function reopenEvents(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Tâches', exact: true }).click();
  await openEvents(page);
}

export interface DirectEvent {
  readonly title: string;
  /** Jour de début ISO. */
  readonly date: string;
  readonly endDate?: string;
  /** Heures 'HH:mm' ; sans elles, journée entière. */
  readonly start?: string;
  readonly end?: string;
  readonly space?: 'pro' | 'perso';
  readonly repeat?: 'once' | 'monthly' | 'yearly';
  readonly kind?: 'event' | 'birthday' | 'important';
  readonly birthYear?: number;
  readonly important?: boolean;
  readonly icon?: string;
}

let sequence = 0;

/** Pose des événements locaux en base (prise de test du navigateur de développement) ; à appeler avant d'ouvrir l'écran. */
export async function insertEvents(page: Page, events: readonly DirectEvent[]): Promise<void> {
  const base = sequence;
  sequence += events.length * 10;
  await page.evaluate(
    async ([list, offset]) => {
      const hooks = window.__ctTest;
      if (!hooks) throw new Error('prise de test absente (navigateur de développement uniquement)');
      const stamp = '2026-01-01T08:00:00.000Z';
      let order = 0;
      for (const event of list) {
        order += 1;
        const n = offset + order;
        await hooks.execute(
          `INSERT INTO event (id, space_id, title, start_date, start_time, end_date, end_time, all_day, kind, repeat, important, icon, birth_year, created_at, updated_at, deleted_at, device_id, hlc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'e2e', ?)`,
          [
            `93000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
            event.space === 'perso' ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001',
            event.title,
            event.date,
            event.start ?? null,
            event.endDate ?? event.date,
            event.end ?? event.start ?? null,
            event.start ? 0 : 1,
            event.kind ?? 'event',
            event.repeat ?? 'once',
            event.important ? 1 : 0,
            event.icon ?? null,
            event.birthYear ?? null,
            stamp,
            stamp,
            `00000000${String(n).padStart(7, '0')}-0000-e2e`,
          ],
        );
      }
    },
    [events, base] as const,
  );
}

/** Ligne de la liste Événements portant ce titre. */
export const eventRow = (page: Page, title: string): Locator => page.locator('.ct-event-row').filter({ has: page.locator('.ct-event-row__title', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

/** Bouton « + » de l'onglet Événements. */
export const addEventButton = (page: Page, testInfo: { project: { name: string } }): Locator =>
  page.getByRole('button', { name: testInfo.project.name === 'iphone' ? 'Ajouter un événement' : 'Ajouter', exact: true });
