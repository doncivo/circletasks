import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../../src/domain/clock';
import type { SyncNowOptions, SyncReason } from '../../../src/platform/sync/types';
import { BEFORE_HIDE_BUDGET_MS, HIDE_SYNC_DEADLINE_MS, startSyncScheduler } from '../../../src/sync';

/**
 * Revue 3 (ADR 0008 §10.8) : au masquage de l'iPhone, le cycle de synchro attend la fin du passage des Rappels Apple, 8 s au plus, pour publier
 * ce que le passage vient de changer. L'échéance du cycle reste mesurée depuis le masquage (une seule tâche d'arrière-plan d'iOS).
 */
afterEach(() => vi.useRealTimers());

function setup() {
  const clock = createManualClock('2026-10-05T08:00:00.000Z');
  const calls: [SyncReason, SyncNowOptions | undefined][] = [];
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    hide() {
      doc.visibilityState = 'hidden';
      for (const listener of listeners) listener();
    },
  };
  return { clock, calls, doc, service: { syncNow: async (reason: SyncReason, options?: SyncNowOptions) => void calls.push([reason, options]) } };
}

describe('cycle `hide` après le passage des Rappels (revue 3)', () => {
  it('le cycle n’est lancé qu’une fois le passage terminé ; son échéance court depuis le masquage', async () => {
    const { clock, calls, doc, service } = setup();
    let finish: () => void = () => undefined;
    const beforeHide = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const scheduler = startSyncScheduler(service, { document: doc as unknown as Document, clock, setInterval: () => 0, clearInterval: () => undefined, hideDeadlineMs: HIDE_SYNC_DEADLINE_MS, beforeHide });
    const openCalls = calls.length;
    const hiddenAt = clock.nowMs();
    doc.hide();
    expect(beforeHide).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(openCalls);
    clock.advance(3_000);
    finish();
    await vi.waitFor(() => expect(calls).toHaveLength(openCalls + 1));
    expect(calls.at(-1)).toEqual(['hide', { deadlineAt: hiddenAt + HIDE_SYNC_DEADLINE_MS }]);
    scheduler.dispose();
  });

  it('un passage qui ne finit pas ne retient le cycle que 8 s', async () => {
    vi.useFakeTimers();
    const { clock, calls, doc, service } = setup();
    const scheduler = startSyncScheduler(service, { document: doc as unknown as Document, clock, setInterval: () => 0, clearInterval: () => undefined, hideDeadlineMs: HIDE_SYNC_DEADLINE_MS, beforeHide: () => new Promise(() => undefined) });
    const openCalls = calls.length;
    doc.hide();
    await vi.advanceTimersByTimeAsync(BEFORE_HIDE_BUDGET_MS - 1);
    expect(calls).toHaveLength(openCalls);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(openCalls + 1);
    expect(calls.at(-1)?.[0]).toBe('hide');
    expect(BEFORE_HIDE_BUDGET_MS).toBe(8_000);
    scheduler.dispose();
  });

  it('un passage qui échoue ne bloque jamais le cycle', async () => {
    const { clock, calls, doc, service } = setup();
    const scheduler = startSyncScheduler(service, { document: doc as unknown as Document, clock, setInterval: () => 0, clearInterval: () => undefined, hideDeadlineMs: HIDE_SYNC_DEADLINE_MS, beforeHide: () => Promise.reject(new Error('panne')) });
    const openCalls = calls.length;
    doc.hide();
    await vi.waitFor(() => expect(calls).toHaveLength(openCalls + 1));
    scheduler.dispose();
  });

  it('sans passage préalable (PC, pas de Rappels) : le cycle part dans le gestionnaire, comme avant', () => {
    const { clock, calls, doc, service } = setup();
    const scheduler = startSyncScheduler(service, { document: doc as unknown as Document, clock, setInterval: () => 0, clearInterval: () => undefined, hideDeadlineMs: HIDE_SYNC_DEADLINE_MS });
    const openCalls = calls.length;
    doc.hide();
    expect(calls).toHaveLength(openCalls + 1);
    scheduler.dispose();
  });
});
