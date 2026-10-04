import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNoticeStore } from '../app/notice';
import { focusStore } from './focusStore';
import { MIN, seedFocusTask, setupFocus, type FocusHarness } from './testKit';

describe('Erreurs d’écriture du Focus (revue)', () => {
  let h: FocusHarness;
  beforeEach(async () => {
    h = await setupFocus('601');
    useNoticeStore.setState({ notice: null });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.db.close();
  });

  it.each(['pause', 'stop', 'setDuration', 'finishTask'] as const)('%s : un échec de la base n’est pas un rejet, un message s’affiche et la session reste', async (action) => {
    const task = await seedFocusTask(h.container);
    const store = focusStore.get(h.container);
    await store.getState().start(task.id);
    h.db.clock.advance(5 * MIN);
    vi.spyOn(h.db.data.repos.focusSessions, 'update').mockRejectedValue(new Error('disque plein'));
    vi.spyOn(h.db.data.repos.focusSessions, 'discard').mockRejectedValue(new Error('disque plein'));
    await expect(action === 'setDuration' ? store.getState().setDuration(50) : store.getState()[action]()).resolves.toBeUndefined();
    expect(useNoticeStore.getState().notice?.text).toBe('Action impossible sur la session Focus.');
    expect(store.getState().session).not.toBeNull();
  });

  it('resume en échec : message, pas de rejet', async () => {
    const task = await seedFocusTask(h.container);
    const store = focusStore.get(h.container);
    await store.getState().start(task.id);
    h.db.clock.advance(MIN);
    await store.getState().pause();
    vi.spyOn(h.db.data.repos.focusSessions, 'update').mockRejectedValue(new Error('x'));
    await expect(store.getState().resume()).resolves.toBeUndefined();
    expect(useNoticeStore.getState().notice?.text).toBe('Action impossible sur la session Focus.');
  });

  it('la file continue après un échec', async () => {
    const task = await seedFocusTask(h.container);
    const store = focusStore.get(h.container);
    await store.getState().start(task.id);
    const spy = vi.spyOn(h.db.data.repos.focusSessions, 'update').mockRejectedValueOnce(new Error('x'));
    await store.getState().pause();
    spy.mockRestore();
    await store.getState().pause();
    expect(store.getState().session?.pausedAt).not.toBeNull();
  });
});
