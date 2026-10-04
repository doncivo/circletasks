import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { elapsedActiveMs } from '../../domain/focusSession';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { undoMessage } from '../app/undo';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { focusStore } from './focusStore';
import { FOCUS_START, MIN, reopen, seedFocusTask, setupFocus, type FocusHarness } from './testKit';

describe('Session Focus : lancement, durée, arrêt, redémarrage (F-01)', () => {
  let h: FocusHarness;
  beforeEach(async () => {
    h = await setupFocus('101');
  });
  afterEach(() => h.db.close());

  const store = (c = h.container) => focusStore.get(c);
  const rows = () => h.db.driver.select<{ id: string; deleted_at: string | null; ended_at: string | null; planned_min: number | null; task_id: string | null; space_id: string }>('SELECT id, deleted_at, ended_at, planned_min, task_id, space_id FROM focus_session ORDER BY started_at', []);

  it('critères 2 et 5 : le lancement enregistre aussitôt la session (tâche, espace, 25 min, début, pauses à 0, fin vide)', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().restore();
    expect(store().getState().duration).toBe(25);
    expect(await store().getState().start(task.id)).toBe('started');
    const [row] = await rows();
    expect(row).toMatchObject({ task_id: task.id, space_id: SPACE_PRO_ID, planned_min: 25, ended_at: null, deleted_at: null });
    const session = store().getState().session;
    expect(session).toMatchObject({ taskId: task.id, spaceId: SPACE_PRO_ID, plannedMin: 25, startedAt: FOCUS_START, endedAt: null, pausedSec: 0, pausedAt: null });
    expect(store().getState().task).toMatchObject({ id: task.id, title: 'Envoyer la facture' });
  });

  it('critère 5 : l’espace de la session est celui de la tâche (Perso)', async () => {
    const task = await seedFocusTask(h.container, 'Courses', { spaceId: SPACE_PERSO_ID });
    await store().getState().start(task.id);
    expect(store().getState().session?.spaceId).toBe(SPACE_PERSO_ID);
  });

  it('critère 6 : une seule session ouverte ; un second lancement est refusé sans rien écrire', async () => {
    const a = await seedFocusTask(h.container, 'A');
    const b = await seedFocusTask(h.container, 'B');
    expect(await store().getState().start(a.id)).toBe('started');
    expect(await store().getState().start(b.id)).toBe('busy');
    expect(await rows()).toHaveLength(1);
    expect(store().getState().session?.taskId).toBe(a.id);
  });

  it('critère 1 : pas de session sur une tâche terminée ni sur une tâche inconnue', async () => {
    const task = await seedFocusTask(h.container);
    await h.db.data.repos.tasks.complete(task.id, FOCUS_START as never);
    h.container.taskEntities.remove([task.id]);
    expect(await store().getState().start(task.id)).toBe('unavailable');
    expect(await store().getState().start('00000000-0000-4000-8000-0000000000ff' as never)).toBe('unavailable');
    expect(await rows()).toHaveLength(0);
  });

  it('critères 4 et 12 : la durée choisie est enregistrée sur la session et mémorisée pour le lancement suivant', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    await store().getState().setDuration(50);
    expect(store().getState().session?.plannedMin).toBe(50);
    expect((await rows())[0]?.planned_min).toBe(50);
    expect(await h.db.data.repos.settings.get('focus.lastDuration')).toBe(50);
    await store().getState().setDuration(null);
    expect(store().getState().session?.plannedMin).toBeNull();
    expect((await rows())[0]?.planned_min).toBeNull();
    expect(await h.db.data.repos.settings.get('focus.lastDuration')).toBeNull();
  });

  it('critère 12 : la dernière durée (Libre comprise) est reprise au lancement suivant et après redémarrage', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    await store().getState().setDuration(null);
    h.db.clock.advance(2 * MIN);
    await store().getState().stop();
    const again = reopen(h);
    await store(again).getState().restore();
    expect(store(again).getState().duration).toBeNull();
    await store(again).getState().start(task.id);
    expect(store(again).getState().session?.plannedMin).toBeNull();
  });

  it('critère 4 : le temps restant est la durée moins le temps écoulé réel', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    h.db.clock.advance(9 * MIN + 26_000);
    const session = store().getState().session;
    expect(session && elapsedActiveMs(session, h.db.clock.nowMs())).toBe(9 * MIN + 26_000);
  });

  it('critère 7 : moins d’une minute de temps actif, la session est supprimée sans trace', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    h.db.clock.advance(59_000);
    await store().getState().stop();
    expect(store().getState().session).toBeNull();
    expect(store().getState().ended).toBeNull();
    const [row] = await rows();
    expect(row?.deleted_at).not.toBeNull();
    expect(await h.db.data.repos.focusSessions.getOpen()).toBeNull();
  });

  it('critère 7 : une minute ou plus est enregistrée à l’instant de l’arrêt', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    h.db.clock.advance(12 * MIN);
    await store().getState().stop();
    const [row] = await rows();
    expect(row).toMatchObject({ deleted_at: null, ended_at: '2026-10-04T08:12:00.000Z' });
    expect(store().getState().session).toBeNull();
    expect(store().getState().revision).toBe(1);
    // L’arrêt ne touche pas à la tâche.
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('todo');
  });

  it('critère 8 : « Terminer la tâche » enregistre la session, termine la tâche et propose Annuler ; annuler rouvre la tâche, la session reste', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    h.db.clock.advance(10 * MIN);
    await store().getState().finishTask();
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    expect(store().getState().session).toBeNull();
    const [row] = await rows();
    expect(row).toMatchObject({ deleted_at: null, ended_at: '2026-10-04T08:10:00.000Z' });
    const top = h.container.undo.getSnapshot().top;
    expect(top && undoMessage(top)).toBe('« Envoyer la facture » terminée');
    await h.container.undo.undoLast();
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('todo');
    expect((await rows())[0]?.ended_at).not.toBeNull();
  });

  it('critère 8 : terminer une tâche récurrente crée l’occurrence suivante (T-09)', async () => {
    const created = await seedFocusTask(h.container, 'Rapport hebdo');
    const set = await createTaskUseCases(h.container).setRecurrence(created.id, { freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null });
    expect(set.ok).toBe(true);
    await store().getState().start(created.id);
    h.db.clock.advance(3 * MIN);
    await store().getState().finishTask();
    const all = await h.db.driver.select<{ n: number }>("SELECT COUNT(*) AS n FROM task WHERE title = 'Rapport hebdo' AND deleted_at IS NULL", []);
    expect(all[0]?.n).toBe(2);
  });

  it('critère 9 : au redémarrage la session est reprise dans son état exact, le temps restant reste juste', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    await store().getState().setDuration(50);
    h.db.clock.advance(20 * MIN);
    const again = reopen(h);
    await store(again).getState().restore();
    const restored = store(again).getState().session;
    expect(restored).toMatchObject({ plannedMin: 50, startedAt: FOCUS_START, endedAt: null });
    expect(store(again).getState().task?.title).toBe('Envoyer la facture');
    expect(restored && elapsedActiveMs(restored, h.db.clock.nowMs())).toBe(20 * MIN);
    expect(store(again).getState().ended).toBeNull();
  });

  it('critère 9 : terme dépassé de plus d’une minute pendant l’absence, la session est close à son terme prévu', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    h.db.clock.advance(25 * MIN + 61_000);
    const again = reopen(h);
    await store(again).getState().restore();
    expect(store(again).getState().session).toBeNull();
    expect(store(again).getState().ended?.minutes).toBe(25);
    const [row] = await rows();
    expect(row?.ended_at).toBe('2026-10-04T08:25:00.000Z');
  });

  it('critère 9 : une session libre est close à 8 h de temps actif', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    await store().getState().setDuration(null);
    h.db.clock.advance(11 * 60 * MIN);
    const again = reopen(h);
    await store(again).getState().restore();
    expect(store(again).getState().session).toBeNull();
    expect(store(again).getState().ended?.minutes).toBe(480);
    expect((await rows())[0]?.ended_at).toBe('2026-10-04T16:00:00.000Z');
  });

  it('critère 9 : rien à restaurer sans session ouverte', async () => {
    await store().getState().restore();
    expect(store().getState()).toMatchObject({ ready: true, session: null, ended: null });
  });

  it('critère 10 : la tâche supprimée, la session continue ; son espace ne change pas même si la tâche est déplacée', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    await h.db.data.repos.tasks.moveToSpace([task.id], SPACE_PERSO_ID, null);
    await h.db.data.repos.tasks.softDelete([task.id]);
    h.container.taskEntities.remove([task.id]);
    await store().getState().refreshTask();
    expect(store().getState().session).not.toBeNull();
    expect(store().getState().task).toBeNull();
    expect((await rows())[0]).toMatchObject({ space_id: SPACE_PRO_ID, deleted_at: null });
    // Terminer la tâche supprimée : la session est simplement enregistrée.
    h.db.clock.advance(5 * MIN);
    await store().getState().finishTask();
    expect((await rows())[0]?.ended_at).not.toBeNull();
  });
});
