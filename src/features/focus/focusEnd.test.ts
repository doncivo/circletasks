import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { createFakeFocusEndScheduler, type FakeFocusEndScheduler } from '../../platform/focus';
import { undoMessage } from '../app/undo';
import { focusStore } from './focusStore';
import { FOCUS_START, MIN, reopen, seedFocusTask, setupFocus, type FocusHarness } from './testKit';

describe('Fin de session (F-04)', () => {
  let h: FocusHarness;
  let scheduler: FakeFocusEndScheduler;
  beforeEach(async () => {
    scheduler = createFakeFocusEndScheduler();
    h = await setupFocus('401', { focusEndScheduler: scheduler });
  });
  afterEach(() => h.db.close());

  const store = (c = h.container) => focusStore.get(c);
  const rows = () => h.db.driver.select<{ id: string; ended_at: string | null; paused_sec: number; deleted_at: string | null }>('SELECT id, ended_at, paused_sec, deleted_at FROM focus_session ORDER BY started_at', []);

  async function startOn(title = 'Envoyer la facture') {
    const task = await seedFocusTask(h.container, title);
    await store().getState().start(task.id);
    return task;
  }

  it('critère 1 : le terme atteint clôt la session à 25 min exactement, sans temps supplémentaire, même constaté en retard', async () => {
    await startOn();
    // Veille de 3 minutes au-delà du terme : constatée au réveil.
    h.db.clock.advance(28 * MIN);
    await store().getState().checkElapsed();
    expect(store().getState().session).toBeNull();
    expect(store().getState().ended?.minutes).toBe(25);
    expect((await rows())[0]?.ended_at).toBe('2026-10-04T08:25:00.000Z');
    expect(await h.db.data.repos.focusSessions.getOpen()).toBeNull();
  });

  it('critère 1 : tant que le terme n’est pas atteint, rien ne se passe ; une seconde avant, la session court encore', async () => {
    await startOn();
    h.db.clock.advance(25 * MIN - 1000);
    await store().getState().checkElapsed();
    expect(store().getState().session).not.toBeNull();
    h.db.clock.advance(1000);
    await store().getState().checkElapsed();
    expect(store().getState().ended).not.toBeNull();
  });

  it('critère 1 : la fin tient compte des pauses (début + durée + pauses)', async () => {
    await startOn();
    h.db.clock.advance(10 * MIN);
    await store().getState().pause();
    h.db.clock.advance(30 * MIN);
    await store().getState().resume();
    h.db.clock.advance(14 * MIN);
    await store().getState().checkElapsed();
    expect(store().getState().session).not.toBeNull();
    h.db.clock.advance(MIN);
    await store().getState().checkElapsed();
    expect(store().getState().ended?.minutes).toBe(25);
    expect((await rows())[0]).toMatchObject({ ended_at: '2026-10-04T08:55:00.000Z', paused_sec: 1800 });
  });

  it('critère 2 : une fin vécue en direct incrémente le signal sonore ; il ne bouge pas à l’arrêt volontaire', async () => {
    const task = await startOn();
    expect(store().getState().soundNonce).toBe(0);
    h.db.clock.advance(5 * MIN);
    await store().getState().stop();
    expect(store().getState().soundNonce).toBe(0);
    await store().getState().start(task.id);
    h.db.clock.advance(25 * MIN);
    await store().getState().checkElapsed();
    expect(store().getState().soundNonce).toBe(1);
  });

  it('critère 3 : le réglage « Son de fin de session » est activé par défaut, local, et se mémorise', async () => {
    await store().getState().restore();
    expect(store().getState().endSound).toBe(true);
    store().getState().setEndSound(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await h.db.data.repos.settings.get('focus.endSound')).toBe(false);
    const again = reopen(h, { focusEndScheduler: scheduler });
    await store(again).getState().restore();
    expect(store(again).getState().endSound).toBe(false);
  });

  it('critère 4 : « Terminer la tâche » depuis l’état terminé termine la tâche (annulable) et ferme l’écran', async () => {
    const task = await startOn();
    h.db.clock.advance(25 * MIN);
    await store().getState().checkElapsed();
    await store().getState().finishTask();
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    expect(store().getState().ended).toBeNull();
    const top = h.container.undo.getSnapshot().top;
    expect(top && undoMessage(top)).toBe('« Envoyer la facture » terminée');
    // La session reste enregistrée telle quelle.
    expect((await rows())[0]?.ended_at).toBe('2026-10-04T08:25:00.000Z');
  });

  it('critère 4 : « Fermer » laisse la tâche inchangée', async () => {
    const task = await startOn();
    h.db.clock.advance(25 * MIN);
    await store().getState().checkElapsed();
    store().getState().dismissEnded();
    expect(store().getState().ended).toBeNull();
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('todo');
  });

  it('critère 4 : « Une autre session » relance sur la même tâche avec la même durée, il n’y a pas de dépassement chronométré', async () => {
    const task = await startOn();
    await store().getState().setDuration(50);
    h.db.clock.advance(50 * MIN);
    await store().getState().checkElapsed();
    h.db.clock.advance(7 * MIN); // personne n'a répondu : le temps ne s'ajoute pas
    expect((await rows())[0]?.ended_at).toBe('2026-10-04T08:50:00.000Z');
    await store().getState().another();
    const session = store().getState().session;
    expect(session).toMatchObject({ taskId: task.id, plannedMin: 50, endedAt: null, startedAt: '2026-10-04T08:57:00.000Z' });
    expect(store().getState().ended).toBeNull();
    expect(await rows()).toHaveLength(2);
  });

  it('critère 4 : « Une autre session » sans effet si la tâche est terminée entre-temps', async () => {
    const task = await startOn();
    h.db.clock.advance(25 * MIN);
    await store().getState().checkElapsed();
    await h.db.data.repos.tasks.complete(task.id, FOCUS_START as never);
    h.container.taskEntities.remove([task.id]);
    await store().getState().another();
    expect(store().getState().session).toBeNull();
    expect(store().getState().ended).toBeNull();
    expect(await rows()).toHaveLength(1);
  });

  it('critère 5 : fin pendant que l’app est fermée : close à son terme, état « terminé » restauré, sans son', async () => {
    await startOn();
    h.db.clock.advance(3 * 60 * MIN);
    const again = reopen(h, { focusEndScheduler: scheduler });
    await store(again).getState().restore();
    expect(store(again).getState().session).toBeNull();
    expect(store(again).getState().ended?.minutes).toBe(25);
    expect(store(again).getState().soundNonce).toBe(0);
    expect((await rows())[0]?.ended_at).toBe('2026-10-04T08:25:00.000Z');
  });

  it('critère 5 : terme dépassé de moins d’une minute au retour : la fin se déroule normalement, avec son', async () => {
    await startOn();
    h.db.clock.advance(25 * MIN + 30_000);
    const again = reopen(h, { focusEndScheduler: scheduler });
    await store(again).getState().restore();
    expect(store(again).getState().ended?.minutes).toBe(25);
    expect(store(again).getState().soundNonce).toBe(1);
  });

  it('critère 6 : une session libre n’a ni fin automatique ni son avant le plafond de 8 h', async () => {
    await startOn();
    await store().getState().setDuration(null);
    h.db.clock.advance(7 * 60 * MIN + 59 * MIN);
    await store().getState().checkElapsed();
    expect(store().getState().session).not.toBeNull();
    expect(store().getState().soundNonce).toBe(0);
    expect(scheduler.pending().size).toBe(0);
  });

  it('critère 4 de F-01 relié à F-04 : changer la durée sous le temps déjà écoulé termine la session à son nouveau terme', async () => {
    await startOn();
    h.db.clock.advance(40 * MIN);
    await store().getState().setDuration(null);
    await store().getState().setDuration(25);
    expect(store().getState().session).toBeNull();
    expect(store().getState().ended?.minutes).toBe(25);
    expect((await rows())[0]?.ended_at).toBe('2026-10-04T08:25:00.000Z');
  });

  it('critère 7 : plages silencieuses et Ne pas déranger ne s’appliquent pas à la fin de Focus (ES-07 critère 8)', async () => {
    // 2026-10-04 est un dimanche : jour des plages silencieuses par défaut de Pro. Le son est quand même signalé.
    await startOn();
    h.db.clock.advance(25 * MIN);
    await store().getState().checkElapsed();
    expect(store().getState().soundNonce).toBe(1);
    // Garde-fou d'architecture : aucun code du Focus ne consulte les plages silencieuses.
    const dir = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(dir).filter((name) => /\.(ts|tsx)$/.test(name) && !name.includes('.test.'));
    for (const name of files) {
      const text = readFileSync(join(dir, name), 'utf8');
      expect(text, name).not.toMatch(/quietHours|effectiveFireAt|doNotDisturb/i);
    }
    expect(SPACE_PRO_ID).toBeTruthy();
  });
});

describe('Notification de fin planifiée : contrat FocusEndScheduler (F-04 critères 8 et 9)', () => {
  let h: FocusHarness;
  let scheduler: FakeFocusEndScheduler;
  beforeEach(async () => {
    scheduler = createFakeFocusEndScheduler();
    h = await setupFocus('402', { focusEndScheduler: scheduler });
  });
  afterEach(() => h.db.close());

  const store = (c = h.container) => focusStore.get(c);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
  const last = () => scheduler.calls.at(-1);

  it('lancement : schedule(sessionId, début + durée prévue, titre de la tâche)', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    const session = store().getState().session;
    expect(scheduler.calls).toEqual([{ type: 'schedule', sessionId: session?.id, fireAt: new Date('2026-10-04T08:25:00.000Z'), title: 'Envoyer la facture' }]);
  });

  it('pause : cancel ; reprise : schedule au nouveau terme (début + durée + pauses)', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    const id = store().getState().session?.id;
    h.db.clock.advance(10 * MIN);
    await store().getState().pause();
    expect(last()).toEqual({ type: 'cancel', sessionId: id });
    expect(scheduler.pending().size).toBe(0);
    h.db.clock.advance(20 * MIN);
    await store().getState().resume();
    expect(last()).toEqual({ type: 'schedule', sessionId: id, fireAt: new Date('2026-10-04T08:45:00.000Z'), title: 'Envoyer la facture' });
  });

  it('changement de durée : schedule au nouveau terme ; Libre : cancel', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    const id = store().getState().session?.id;
    await store().getState().setDuration(50);
    expect(last()).toEqual({ type: 'schedule', sessionId: id, fireAt: new Date('2026-10-04T08:50:00.000Z'), title: 'Envoyer la facture' });
    await store().getState().setDuration(null);
    expect(last()).toEqual({ type: 'cancel', sessionId: id });
  });

  it('arrêt, « Terminer la tâche » et fin : cancel', async () => {
    const a = await seedFocusTask(h.container, 'A');
    await store().getState().start(a.id);
    h.db.clock.advance(5 * MIN);
    await store().getState().stop();
    expect(scheduler.pending().size).toBe(0);
    expect(last()?.type).toBe('cancel');
    await store().getState().start(a.id);
    h.db.clock.advance(5 * MIN);
    await store().getState().finishTask();
    expect(scheduler.pending().size).toBe(0);
    const b = await seedFocusTask(h.container, 'B');
    await store().getState().start(b.id);
    expect(scheduler.pending().size).toBe(1);
    h.db.clock.advance(25 * MIN);
    await store().getState().checkElapsed();
    expect(scheduler.pending().size).toBe(0);
  });

  it('redémarrage avec une session ouverte : la notification est replanifiée', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    h.db.clock.advance(10 * MIN);
    const second = createFakeFocusEndScheduler();
    const again = reopen(h, { focusEndScheduler: second });
    await store(again).getState().restore();
    await flush();
    expect(second.pending().size).toBe(1);
    expect([...second.pending().values()][0]?.fireAt).toEqual(new Date('2026-10-04T08:25:00.000Z'));
  });

  it('une panne du planificateur n’interrompt jamais la session', async () => {
    const broken = {
      schedule: () => Promise.reject(new Error('indisponible')),
      cancel: () => Promise.reject(new Error('indisponible')),
    };
    const container = reopen(h, { focusEndScheduler: broken });
    const task = await seedFocusTask(container);
    expect(await store(container).getState().start(task.id)).toBe('started');
    h.db.clock.advance(5 * MIN);
    await store(container).getState().pause();
    await store(container).getState().stop();
    expect(store(container).getState().session).toBeNull();
  });
});
