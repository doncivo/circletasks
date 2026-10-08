import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteChanges } from '../../../platform/sync/types';
import type { LocalDate } from '../../../domain/types';
import { createUnavailableReminders } from '../../../platform/reminders';
import { useAppStatusStore } from '../../app/appStatus';
import { appleRemindersStore } from './appleRemindersState';
import { PUSH_DELAY_MS } from './remindersRunner';
import { startRemindersIntegration, type RemindersEnv } from './startReminders';
import { PERSO, setupRemindersHarness, type RemindersHarness } from './testKit';

let h: RemindersHarness;
const syncListeners = new Set<(change: RemoteChanges) => void>();
const fakeSync = { onRemoteChanges: (listener: (change: RemoteChanges) => void) => (syncListeners.add(listener), () => syncListeners.delete(listener)) } as never;

beforeEach(async () => {
  syncListeners.clear();
  h = await setupRemindersHarness('3', { sync: fakeSync });
  await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.close();
});

function documentStub(): RemindersEnv['document'] & { set(state: 'visible' | 'hidden'): void; listeners: number } {
  const listeners = new Set<() => void>();
  let visibilityState: DocumentVisibilityState = 'visible';
  return {
    get visibilityState() {
      return visibilityState;
    },
    get listeners() {
      return listeners.size;
    },
    addEventListener: ((_: string, handler: () => void) => void listeners.add(handler)) as Document['addEventListener'],
    removeEventListener: ((_: string, handler: () => void) => void listeners.delete(handler)) as Document['removeEventListener'],
    set(state) {
      visibilityState = state;
      for (const listener of [...listeners]) listener();
    },
  };
}

const D = (value: string): LocalDate => value as LocalDate;
const fetches = (): number => h.reminders.calls.filter((call) => call.name === 'fetch').length;
/** Les accès à la base sont asynchrones : on attend une condition observable, jamais un délai. */
const until = (check: () => void | Promise<void>): Promise<void> => vi.waitFor(check, { timeout: 5_000, interval: 5 });

describe('déclencheurs des passages (K-05 critère 11)', () => {
  it('ouverture, reprise, masquage, événement changed et synchro reçue lancent un passage ; démontage : plus aucun abonnement', async () => {
    h.reminders.add({ listId: 'L-courses', title: 'Pain' });
    const doc = documentStub();
    const integration = startRemindersIntegration(h.container, { document: doc });
    await integration.opened();
    expect(fetches()).toBe(1);
    expect(await h.tasks()).toHaveLength(1);

    doc.set('hidden');
    await until(() => expect(fetches()).toBe(2));
    doc.set('visible');
    await until(() => expect(fetches()).toBe(3));

    // L'événement EventKit : sans relancer l'app, la modification de Rappels est reprise.
    h.db.clock.advance(60_000);
    h.reminders.edit(h.reminders.all()[0]?.id ?? '', { title: 'Pain complet' });
    h.reminders.emitChanged();
    await until(async () => expect((await h.tasks())[0]?.title).toBe('Pain complet'));
    const before = fetches();
    expect(before).toBeGreaterThanOrEqual(4);

    // Une synchro qui apporte des tâches relance un passage ; une table sans rapport, non.
    for (const listener of syncListeners) listener({ tables: new Set(['routine']), ids: new Map() });
    for (const listener of syncListeners) listener({ tables: new Set(['task']), ids: new Map() });
    await until(() => expect(fetches()).toBe(before + 1));

    integration.dispose();
    expect(doc.listeners).toBe(0);
    expect(syncListeners.size).toBe(0);
    expect(h.reminders.listenerCount()).toBe(0);
  });

  it('une écriture locale programme un passage push 6 s plus tard (annulation de 5 s), jamais avant', async () => {
    const programmed: { handler: () => void; ms: number }[] = [];
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === PUSH_DELAY_MS) {
        programmed.push({ handler, ms });
        return 0 as never;
      }
      return real(handler, ms, ...(rest as []));
    }) as typeof setTimeout);
    const integration = startRemindersIntegration(h.container, { document: documentStub() });
    await integration.opened();
    const base = fetches();
    await h.container.data.repos.tasks.create({
      id: '90000000-0000-4000-8000-000000000001' as never, spaceId: PERSO, projectId: null, title: 'Écrite ici', note: '', date: D('2026-10-08'), time: null, status: 'todo', doneAt: null, sortOrder: 1, carriedOver: false, recurrenceId: null, seriesIndex: null, seriesTemplate: null, goalId: null, icon: null, someday: false, source: 'local', externalId: null, appleListId: null, appleRecurring: false, externalEventId: null,
    });
    expect(programmed).toHaveLength(1);
    // Rien n'est parti avant l'échéance.
    expect(fetches()).toBe(base);
    spy.mockRestore();
    programmed[0]?.handler();
    await until(() => expect(fetches()).toBe(base + 1));
    integration.dispose();
  });

  it('sur PC : aucun passage, aucun appel de plugin ; les réglages sont lus et relus quand la synchro en apporte', async () => {
    const pc = await setupRemindersHarness('4', { runtime: 'tauri', os: 'windows', sync: fakeSync, reminders: createUnavailableReminders() });
    const integration = startRemindersIntegration(pc.container, { document: documentStub() });
    await integration.opened();
    await pc.container.data.repos.settings.set('appleReminders.lastPassAt', '2026-10-08T08:00:00.000Z' as never);
    for (const listener of syncListeners) listener({ tables: new Set(['settings']), ids: new Map() });
    await until(() => expect(appleRemindersStore.get(pc.container).getState()).toMatchObject({ loaded: true, available: false, lastPassAt: '2026-10-08T08:00:00.000Z' }));
    expect(pc.reminders.calls).toEqual([]);
    expect(useAppStatusStore.getState().sources.appleRemindersTrouble).toBeUndefined();
    integration.dispose();
    await pc.close();
  });
});

describe('écoute impossible rendue visible (revue, mineur)', () => {
  it('l’écoute des changements d’EventKit échoue : message dans l’écran Agendas, les passages à l’ouverture et à la reprise continuent', async () => {
    vi.spyOn(h.reminders, 'onChanged').mockRejectedValue(new Error('écoute refusée'));
    const integration = startRemindersIntegration(h.container, { document: documentStub() });
    await integration.opened();
    await vi.waitFor(() => expect(appleRemindersStore.get(h.container).getState().status.notices).toContainEqual(expect.objectContaining({ kind: 'listener-failed' })));
    integration.dispose();
  });
});
