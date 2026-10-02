import { expect, type Locator, type Page } from '@playwright/test';
import { addIsoDays } from './schedule';
import { isPhone } from './today';

/** Aides e2e de l'onglet Routines (R-01 à R-07), communes aux projets `pc` et `iphone`. */

export const routinesTab = (page: Page): Locator => page.getByRole('navigation').getByRole('button', { name: 'Routines', exact: true });

/** Ouvre l'onglet Routines et attend son titre. */
export async function openRoutines(page: Page): Promise<void> {
  await routinesTab(page).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
}

/** Carte d'une routine, par son titre exact. */
export const cardOf = (page: Page, title: string): Locator =>
  page.locator('article.ct-routine-card').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) });

/** Formulaire de routine ouvert (feuille iPhone ou panneau PC), par son titre. */
export const routineForm = (page: Page, heading: 'Nouvelle routine' | 'Modifier la routine'): Locator => page.getByRole('form', { name: heading });

/** Lundi de la semaine de la date ISO donnée. */
export function mondayOfIso(iso: string): string {
  const weekday = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = dimanche
  return addIsoDays(iso, -((weekday + 6) % 7));
}

export interface DirectRoutine {
  readonly title: string;
  readonly space?: 'pro' | 'perso';
  readonly scheduleType?: 'daily' | 'weekdays' | 'x_per_week' | 'every_n_days' | 'every_n_weeks';
  readonly weekdays?: readonly number[];
  readonly timesPerWeek?: number;
  readonly interval?: number;
  /** Date de départ ISO ; par défaut le 1er janvier 2026 (tout le passé récent est prévu). */
  readonly startDate?: string;
  readonly time?: string;
  readonly icon?: string;
  readonly paused?: boolean;
  readonly archived?: boolean;
  /** Dates ISO validées. */
  readonly done?: readonly string[];
}

let sequence = 0;

/** Pose des routines et leurs validations en base (prise de test du navigateur de développement) ; à appeler avant d'ouvrir l'écran. */
export async function insertRoutines(page: Page, items: readonly DirectRoutine[]): Promise<void> {
  const base = sequence;
  sequence += items.length * 100;
  await page.evaluate(
    async ([routines, offset]) => {
      const hooks = window.__ctTest;
      if (!hooks) throw new Error('prise de test absente (navigateur de développement uniquement)');
      let order = 0;
      for (const item of routines) {
        order += 1;
        const n = String(offset + order).padStart(12, '0');
        const id = `82000000-0000-4000-8000-${n}`;
        await hooks.execute(
          `INSERT INTO routine (id, space_id, title, icon, schedule_type, weekdays, times_per_week, interval, start_date, time, paused, archived, created_at, updated_at, device_id, hlc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T08:00:00.000Z', '2026-01-01T08:00:00.000Z', 'e2e', ?)`,
          [
            id,
            item.space === 'perso' ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001',
            item.title,
            item.icon ?? null,
            item.scheduleType ?? 'daily',
            JSON.stringify(item.weekdays ?? []),
            item.timesPerWeek ?? null,
            item.interval ?? null,
            item.startDate ?? '2026-01-01',
            item.time ?? null,
            item.paused ? 1 : 0,
            item.archived ? 1 : 0,
            `00000000${String(offset + order).padStart(5, '0')}-0000-e2e`,
          ],
        );
        let logOrder = 0;
        for (const date of item.done ?? []) {
          logOrder += 1;
          await hooks.execute(
            `INSERT INTO routine_log (id, routine_id, date, done_at, created_at, updated_at, device_id, hlc)
             VALUES (?, ?, ?, ?, '2026-01-01T08:00:00.000Z', '2026-01-01T08:00:00.000Z', 'e2e', ?)`,
            [
              `83000000-0000-4000-8000-${String((offset + order) * 100 + logOrder).padStart(12, '0')}`,
              id,
              date,
              `${date}T08:00:00.000Z`,
              `10000${String(offset + order).padStart(4, '0')}${String(logOrder).padStart(4, '0')}-0000-e2e`,
            ],
          );
        }
      }
    },
    [items, base] as const,
  );
}

export interface NewRoutineInput {
  readonly title: string;
  /** Fréquence : valeur du sélecteur ; `days` pour « Jours choisis » (noms de jours), `times` pour « X fois par semaine ». */
  readonly frequency?: 'daily' | 'weekdays' | 'x_per_week' | 'every_n';
  readonly days?: readonly string[];
  readonly times?: number;
  readonly space?: 'Pro' | 'Perso';
}

/** Crée une routine par l'interface : bouton « + » (iPhone et PC) puis formulaire. L'onglet Routines doit être ouvert. */
export async function createRoutine(page: Page, testInfo: { project: { name: string } }, input: NewRoutineInput): Promise<void> {
  await page.getByRole('button', { name: isPhone(testInfo) ? 'Ajouter une routine' : 'Ajouter', exact: true }).click();
  const form = routineForm(page, 'Nouvelle routine');
  await form.getByLabel('Nom de la routine').fill(input.title);
  if (input.frequency && input.frequency !== 'daily') await form.getByLabel('Fréquence', { exact: true }).selectOption(input.frequency);
  for (const day of input.days ?? []) await form.getByRole('checkbox', { name: day, exact: true }).click();
  if (input.times !== undefined) {
    const plus = form.getByRole('button', { name: 'Augmenter' });
    for (let i = 3; i < input.times; i += 1) await plus.click();
    const minus = form.getByRole('button', { name: 'Diminuer' });
    for (let i = 3; i > input.times; i -= 1) await minus.click();
  }
  if (input.space) await form.getByRole('button', { name: input.space, exact: true }).click();
  await form.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(form).not.toBeVisible();
}
