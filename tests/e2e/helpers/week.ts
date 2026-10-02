import { expect, type Locator, type Page } from '@playwright/test';
import { addIsoDays, browserToday } from './schedule';

/** Aides e2e de la Semaine (S-01 à S-05), communes aux projets `pc` et `iphone`. */

/** Lundi de la semaine de la date ISO donnée (arithmétique UTC, sans effet de fuseau). */
export function mondayOf(iso: string): string {
  const weekday = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = dimanche
  return addIsoDays(iso, -((weekday + 6) % 7));
}

/** Lundi de la semaine courante du navigateur. */
export async function browserMonday(page: Page): Promise<string> {
  return mondayOf(await browserToday(page));
}

export const weekTab = (page: Page): Locator => page.getByRole('navigation').getByRole('button', { name: 'Semaine', exact: true });

/** Ouvre l'onglet Semaine (clic sur l'onglet) et attend les sept jours. */
export async function openWeek(page: Page): Promise<void> {
  await weekTab(page).click();
  await expect(page.locator('.ct-week-day')).toHaveCount(7);
}

/** Colonne (PC) ou section (iPhone) d'un jour, par sa date ISO. */
export const dayOf = (page: Page, iso: string): Locator => page.locator(`.ct-week-day[data-date="${iso}"]`);

/** Titres des tâches d'un jour, dans l'ordre d'affichage. */
export async function dayTitles(page: Page, iso: string): Promise<string[]> {
  return dayOf(page, iso).locator('.ct-week-item__title').allTextContents();
}

/** Bouton de titre d'une tâche (nom exact) dans toute la Semaine. */
export const taskButton = (page: Page, title: string): Locator => page.getByRole('button', { name: title, exact: true });

/** Tâche posée directement en base par la prise de test du navigateur de développement (`window.__ctTest`, src/db/testHooks.ts). */
export interface DirectTask {
  readonly title: string;
  readonly date: string;
  readonly time?: string;
  readonly space?: 'pro' | 'perso';
  readonly done?: boolean;
  /** Badge « reportée » (T-06). */
  readonly carried?: boolean;
  /** Série « tous les jours » (règle posée en base) : l'occurrence est la première de la série. */
  readonly daily?: boolean;
}

/** Insère des tâches en base (espace, état et badge maîtrisés) ; à appeler avant d'ouvrir l'écran qui les affiche. */
export async function insertTasks(page: Page, items: readonly DirectTask[]): Promise<void> {
  await page.evaluate(async (tasks) => {
    const hooks = window.__ctTest;
    if (!hooks) throw new Error('prise de test absente (navigateur de développement uniquement)');
    let order = 0;
    for (const item of tasks) {
      order += 1;
      const n = String(order).padStart(12, '0');
      const stamp = `00000000000${String(order).padStart(4, '0')}-0000-e2e`;
      const ruleId = `31000000-0000-4000-8000-${n}`;
      if (item.daily) {
        await hooks.execute(
          `INSERT INTO recurrence (id, freq, interval, weekdays, created_at, updated_at, device_id, hlc)
           VALUES (?, 'daily', 1, '[]', '2026-09-20T08:00:00.000Z', '2026-09-20T08:00:00.000Z', 'e2e', ?)`,
          [ruleId, stamp],
        );
      }
      await hooks.execute(
        `INSERT INTO task (id, space_id, title, date, time, status, done_at, sort_order, carried_over, recurrence_id, series_index, created_at, updated_at, device_id, hlc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-20T08:00:00.000Z', '2026-09-20T08:00:00.000Z', 'e2e', ?)`,
        [
          `30000000-0000-4000-8000-${n}`,
          item.space === 'perso' ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001',
          item.title,
          item.date,
          item.time ?? null,
          item.done ? 'done' : 'todo',
          item.done ? '2026-09-22T08:00:00.000Z' : null,
          order,
          item.carried ? 1 : 0,
          item.daily ? ruleId : null,
          item.daily ? 0 : null,
          stamp,
        ],
      );
    }
  }, items);
}

const SPACE_PRO = '00000000-0000-4000-8000-000000000001';
const SPACE_PERSO = '00000000-0000-4000-8000-000000000002';

/** Compte « Google Agenda » avec trois agendas : Travail (Pro), Famille (Perso), Libre (non rattaché). Jeu de test, aucun connecteur avant K-01. */
export async function seedCalendarAccount(page: Page): Promise<void> {
  await page.evaluate(
    async ([pro, perso]) => {
      await window.__ctTest?.seedCalendarAccount({
        id: 'acc-google',
        provider: 'google',
        label: 'Google Agenda',
        calendars: [
          { id: 'pro', name: 'Travail', spaceId: pro as never, shown: true },
          { id: 'perso', name: 'Famille', spaceId: perso as never, shown: true },
          { id: 'libre', name: 'Libre', spaceId: null, shown: true },
        ],
      });
    },
    [SPACE_PRO, SPACE_PERSO] as const,
  );
}

export interface ExternalEventSeed {
  readonly id: string;
  readonly title: string;
  readonly startUtc: string;
  readonly endUtc?: string | null;
  readonly allDay?: boolean;
  readonly calendarId?: 'pro' | 'perso' | 'libre';
}

/** Pose un événement d'agenda externe en base (instants UTC). */
export async function seedExternalEvent(page: Page, event: ExternalEventSeed): Promise<void> {
  await page.evaluate(
    async (seed) => {
      await window.__ctTest?.seedExternalEvent({
        id: seed.id,
        accountId: 'acc-google',
        calendarId: seed.calendarId ?? 'pro',
        title: seed.title,
        startUtc: seed.startUtc,
        endUtc: seed.endUtc ?? null,
        allDay: seed.allDay ?? false,
      });
    },
    event,
  );
}

/** Heure locale « HH:mm » d'un instant UTC dans le fuseau `timeZone` (calcul indépendant de l'app, pour les attentes). */
export function localTime(instantUtc: string, timeZone: string): string {
  return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(instantUtc));
}
