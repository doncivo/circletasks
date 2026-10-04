import type { Page } from '@playwright/test';

/** Aides e2e du Focus (F-01 à F-04), communes aux projets `pc` et `iphone`. */

export interface DirectFocusSession {
  /** Début, instant UTC ISO. */
  readonly startedAt: string;
  /** Minutes de concentration (la session est terminée à `startedAt` + minutes + pauses). */
  readonly minutes: number;
  readonly space?: 'pro' | 'perso';
  readonly pausedSec?: number;
}

/** Insère des sessions terminées en base par la prise de test (navigateur de développement) ; à appeler avant d'ouvrir l'écran concerné. */
export async function insertFocusSessions(page: Page, items: readonly DirectFocusSession[]): Promise<void> {
  await page.evaluate(async (sessions) => {
    const hooks = window.__ctTest;
    if (!hooks) throw new Error('prise de test absente (navigateur de développement uniquement)');
    let order = 0;
    for (const item of sessions) {
      order += 1;
      const stamp = `${String(Date.now() + order).padStart(15, '0')}-0000-e2e`;
      const paused = item.pausedSec ?? 0;
      const ended = new Date(Date.parse(item.startedAt) + item.minutes * 60_000 + paused * 1000).toISOString();
      await hooks.execute(
        `INSERT INTO focus_session (id, task_id, space_id, planned_min, started_at, ended_at, paused_sec, paused_at, created_at, updated_at, device_id, hlc)
         VALUES (?, NULL, ?, 25, ?, ?, ?, NULL, ?, ?, 'e2e', ?)`,
        [crypto.randomUUID(), item.space === 'perso' ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001', item.startedAt, ended, paused, item.startedAt, ended, stamp],
      );
    }
  }, items);
}
