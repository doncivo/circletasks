import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { elapsedActiveMs, remainingMs } from '../../domain/focusSession';
import { focusStore } from './focusStore';
import { MIN, reopen, seedFocusTask, setupFocus, type FocusHarness } from './testKit';

describe('Pause et reprise d’une session (F-02)', () => {
  let h: FocusHarness;
  beforeEach(async () => {
    h = await setupFocus('201');
  });
  afterEach(() => h.db.close());

  const store = (c = h.container) => focusStore.get(c);
  const row = async () => (await h.db.driver.select<{ paused_at: string | null; paused_sec: number; ended_at: string | null }>('SELECT paused_at, paused_sec, ended_at FROM focus_session WHERE deleted_at IS NULL', []))[0];

  async function startOn(title = 'Envoyer la facture') {
    const task = await seedFocusTask(h.container, title);
    await store().getState().start(task.id);
    return task;
  }

  it('critère 1 : « Pause » écrit paused_at et fige le temps restant', async () => {
    await startOn();
    h.db.clock.advance(9 * MIN + 26_000);
    await store().getState().pause();
    expect((await row())?.paused_at).toBe('2026-10-04T08:09:26.000Z');
    h.db.clock.advance(20 * MIN);
    const session = store().getState().session;
    expect(session && remainingMs(session, h.db.clock.nowMs())).toBe(15 * MIN + 34_000);
  });

  it('critère 2 : « Reprendre » ajoute la durée de la pause à paused_sec et vide paused_at', async () => {
    await startOn();
    h.db.clock.advance(9 * MIN + 26_000);
    await store().getState().pause();
    h.db.clock.advance(20 * MIN);
    await store().getState().resume();
    expect(await row()).toMatchObject({ paused_at: null, paused_sec: 1200 });
    const session = store().getState().session;
    expect(session && remainingMs(session, h.db.clock.nowMs())).toBe(15 * MIN + 34_000);
    h.db.clock.advance(MIN);
    expect(session && remainingMs(session, h.db.clock.nowMs())).toBe(14 * MIN + 34_000);
  });

  it('critère 3 : plusieurs pauses, le temps enregistré = fin - début - pauses', async () => {
    await startOn();
    h.db.clock.advance(5 * MIN);
    await store().getState().pause();
    h.db.clock.advance(5 * MIN);
    await store().getState().resume();
    h.db.clock.advance(5 * MIN);
    await store().getState().pause();
    h.db.clock.advance(150_000);
    await store().getState().resume();
    h.db.clock.advance(15 * MIN);
    await store().getState().stop();
    expect(await row()).toMatchObject({ paused_sec: 450, ended_at: '2026-10-04T08:32:30.000Z' });
    const closed = await h.db.data.repos.focusSessions.getById((await h.db.driver.select<{ id: string }>('SELECT id FROM focus_session', []))[0]?.id as never);
    expect(closed && elapsedActiveMs(closed, h.db.clock.nowMs())).toBe(25 * MIN);
  });

  it('critère 4 : pause pendant que l’app est fermée ou l’appareil en veille, l’état « En pause » est restauré au redémarrage', async () => {
    await startOn();
    h.db.clock.advance(10 * MIN);
    await store().getState().pause();
    // Veille puis fermeture : 3 heures plus tard, redémarrage.
    h.db.clock.advance(3 * 60 * MIN);
    const again = reopen(h);
    await store(again).getState().restore();
    const restored = store(again).getState().session;
    expect(restored?.pausedAt).toBe('2026-10-04T08:10:00.000Z');
    expect(store(again).getState().ended).toBeNull();
    // Le terme n’est pas atteint : la pause ne consomme pas le temps actif.
    expect(restored && elapsedActiveMs(restored, h.db.clock.nowMs())).toBe(10 * MIN);
    await store(again).getState().resume();
    expect((await row())?.paused_sec).toBe(3 * 60 * 60);
  });

  it('critère 5 : arrêter en pause clôt la pause à cet instant, seul le temps actif est enregistré', async () => {
    await startOn();
    h.db.clock.advance(10 * MIN);
    await store().getState().pause();
    h.db.clock.advance(30 * MIN);
    await store().getState().stop();
    expect(await row()).toMatchObject({ paused_at: null, paused_sec: 1800, ended_at: '2026-10-04T08:40:00.000Z' });
  });

  it('critère 5 : « Terminer la tâche » en pause enregistre le temps actif et termine la tâche', async () => {
    const task = await startOn();
    h.db.clock.advance(10 * MIN);
    await store().getState().pause();
    h.db.clock.advance(5 * MIN);
    await store().getState().finishTask();
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    expect(await row()).toMatchObject({ paused_at: null, paused_sec: 300 });
  });

  it('une pause trop courte (moins d’une minute de temps actif) ne sauve pas la session', async () => {
    await startOn();
    h.db.clock.advance(20_000);
    await store().getState().pause();
    h.db.clock.advance(60 * MIN);
    await store().getState().stop();
    expect(await row()).toBeUndefined();
  });

  it('pause et reprise répétées sont sans effet : une seule pause ouverte à la fois', async () => {
    await startOn();
    h.db.clock.advance(MIN);
    await store().getState().pause();
    h.db.clock.advance(MIN);
    await store().getState().pause();
    expect((await row())?.paused_at).toBe('2026-10-04T08:01:00.000Z');
    await store().getState().resume();
    await store().getState().resume();
    expect((await row())?.paused_sec).toBe(60);
  });

  it('pause pendant un terme atteint : rien n’est clos tant que la session est en pause', async () => {
    await startOn();
    h.db.clock.advance(10 * MIN);
    await store().getState().pause();
    h.db.clock.advance(8 * 60 * MIN);
    await store().getState().checkElapsed();
    expect(store().getState().session).not.toBeNull();
    expect(store().getState().ended).toBeNull();
  });
});
