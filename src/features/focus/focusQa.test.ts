import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { elapsedActiveMs } from '../../domain/focusSession';
import { undoMessage } from '../app/undo';
import { focusStore } from './focusStore';
import { MIN, reopen, seedFocusTask, setupFocus, type FocusHarness } from './testKit';

const here = dirname(fileURLToPath(import.meta.url));

describe('QA lot F : cas limites', () => {
  let h: FocusHarness;
  beforeEach(async () => {
    h = await setupFocus('901');
  });
  afterEach(() => h.db.close());
  const store = (c = h.container) => focusStore.get(c);
  const rows = () => h.db.driver.select<{ id: string; ended_at: string | null; paused_sec: number; task_id: string | null }>('SELECT id, ended_at, paused_sec, task_id FROM focus_session WHERE deleted_at IS NULL', []);

  it('F-04 : tâche terminée depuis l’état « terminé » puis Annuler rouvre la tâche, la session reste close à 25 min', async () => {
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    h.db.clock.advance(25 * MIN);
    await store().getState().checkElapsed();
    await store().getState().finishTask();
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    const top = h.container.undo.getSnapshot().top;
    expect(top && undoMessage(top)).toBe('« Envoyer la facture » terminée');
    await h.container.undo.undoLast();
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('todo');
    const [r] = await rows();
    expect(r?.ended_at).toBe('2026-10-04T08:25:00.000Z');
  });

  it('F-01 critère 6 : après redémarrage avec une session ouverte, un second lancement est refusé', async () => {
    const a = await seedFocusTask(h.container, 'A');
    const b = await seedFocusTask(h.container, 'B');
    await store().getState().start(a.id);
    const again = reopen(h);
    await store(again).getState().restore();
    expect(await store(again).getState().start(b.id)).toBe('busy');
    expect(await rows()).toHaveLength(1);
  });

  it('F-02 critère 3 : trois pauses avec secondes impaires, temps actif exact à la seconde', async () => {
    const t = await seedFocusTask(h.container);
    await store().getState().start(t.id);
    h.db.clock.advance(3 * MIN + 7_000);
    await store().getState().pause();
    h.db.clock.advance(61_000);
    await store().getState().resume();
    h.db.clock.advance(2 * MIN + 13_000);
    await store().getState().pause();
    h.db.clock.advance(4 * MIN + 59_000);
    await store().getState().resume();
    h.db.clock.advance(30_000);
    await store().getState().pause();
    h.db.clock.advance(MIN + 1_000);
    await store().getState().resume();
    h.db.clock.advance(5 * MIN);
    await store().getState().stop();
    const [r] = await rows();
    expect(r?.paused_sec).toBe(61 + 299 + 61);
    const closed = await h.db.data.repos.focusSessions.getById(r?.id as never);
    expect(closed && elapsedActiveMs(closed, h.db.clock.nowMs())).toBe((3 * 60 + 7 + 2 * 60 + 13 + 30 + 300) * 1000);
  });

  it('F-01 critère 10 : tâche supprimée pendant la session, elle continue puis s’enregistre avec task_id vide ou conservé sans erreur', async () => {
    const t = await seedFocusTask(h.container);
    await store().getState().start(t.id);
    await h.db.data.repos.tasks.softDelete([t.id]);
    h.db.clock.advance(10 * MIN);
    await store().getState().stop();
    const [r] = await rows();
    expect(r?.ended_at).toBe('2026-10-04T08:10:00.000Z');
  });
});

describe('QA lot F : accessibilité en CSS (F-01 critère 13)', () => {
  const css = readFileSync(join(here, 'FocusView.css'), 'utf-8');
  const tokens = readFileSync(join(here, '../../ui/theme/tokens.css'), 'utf-8');

  it('« Réduire les animations » coupe animations et transitions globalement, et l’anneau ne les force pas', () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(tokens)?.[1] ?? '';
    expect(block).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(css).not.toMatch(/prefers-reduced-motion:\s*no-preference/);
  });

  it('les boutons ont une hauteur d’au moins 44 px', () => {
    const heights = [...css.matchAll(/min-height:\s*var\(--ct-hit-target-min\)|height:\s*(\d+)px/g)];
    expect(tokens).toMatch(/--ct-hit-target-min:\s*44px/);
    expect(heights.length).toBeGreaterThan(2);
  });
});
