import { expect, type Locator, type Page } from '@playwright/test';
import { REPORT_FONT_FACES, REPORT_FONT_SAMPLE } from '../../../src/features/stats/reportFonts';
import { APP_READY_TIMEOUT_MS, waitForScreenLoaded } from './app';

/** Aides e2e des statistiques (H-01 à H-03, ES-08), communes aux projets `pc` et `iphone`. */

/**
 * Attend que les polices du rapport exporté soient chargées (état `document.fonts`, jamais un délai). Leurs fichiers sont servis à la
 * demande : l'export en PDF ou en image les télécharge au premier clic, ce qui dépasse les 5 s d'une assertion sur une machine chargée
 * (H-03 critère 5, instable sur la CI). À appeler avant de lancer un export PDF ou image ; l'app affiche « Export en cours… » entre-temps.
 */
export async function waitForReportFonts(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ faces, sample }) => {
            for (const face of faces) void document.fonts.load(face, sample).catch(() => undefined);
            return faces.every((face) => document.fonts.check(face, sample));
          },
          { faces: [...REPORT_FONT_FACES], sample: REPORT_FONT_SAMPLE },
        ),
      { message: 'polices du rapport jamais chargées', timeout: APP_READY_TIMEOUT_MS },
    )
    .toBe(true);
}

export interface DirectTask {
  readonly title: string;
  /** Date ISO 'AAAA-MM-JJ' (absente : tâche sans date). */
  readonly date?: string;
  readonly done?: boolean;
  readonly space?: 'pro' | 'perso';
  /** Nom d'un projet déjà créé (par son nom exact). */
  readonly project?: string;
  /** Note (export). */
  readonly note?: string;
  readonly time?: string;
}

/** Insère des tâches en base par la prise de test (navigateur de développement) ; à appeler avant d'ouvrir l'écran concerné. */
export async function insertTasks(page: Page, items: readonly DirectTask[]): Promise<void> {
  await page.evaluate(async (tasks) => {
    const hooks = window.__ctTest;
    if (!hooks) throw new Error('prise de test absente (navigateur de développement uniquement)');
    const base = Date.now();
    let order = 0;
    for (const item of tasks) {
      order += 1;
      const stamp = `${String(base + order).padStart(15, '0')}-0000-e2e`;
      const at = new Date(base + order).toISOString();
      const project = item.project ? `(SELECT id FROM project WHERE name = '${item.project.replace(/'/g, "''")}' LIMIT 1)` : 'NULL';
      await hooks.execute(
        `INSERT INTO task (id, space_id, project_id, title, note, date, time, status, done_at, sort_order, created_at, updated_at, device_id, hlc)
         VALUES (?, ?, ${project}, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'e2e', ?)`,
        [
          crypto.randomUUID(),
          item.space === 'perso' ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001',
          item.title,
          item.note ?? '',
          item.date ?? null,
          item.time ?? null,
          item.done ? 'done' : 'todo',
          item.done ? `${item.date ?? '2026-01-01'}T08:00:00.000Z` : null,
          order,
          at,
          at,
          stamp,
        ],
      );
    }
  }, items);
}

/** Icône graphique d'Aujourd'hui : ouvre le rapport du mois. */
export const reportButton = (page: Page): Locator => page.getByRole('button', { name: 'Rapport mensuel' });

/** Ouvre le rapport depuis Aujourd'hui et attend son titre. */
export async function openReport(page: Page, month: string): Promise<void> {
  await waitForScreenLoaded(page, 'reportscreen');
  await reportButton(page).click();
  await expect(page.getByRole('heading', { level: 1, name: month, exact: true })).toBeVisible();
}

/** Tuile du rapport, par son nom accessible (« Tâches faites : 4 sur 6 »). */
export const tileOf = (page: Page, name: string | RegExp): Locator => page.getByRole('group', { name });
