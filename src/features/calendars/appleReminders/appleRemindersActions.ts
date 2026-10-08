import { MAX_APPLE_LISTS, type AppleListSetting, type AppleNoticeKind, type ReminderList } from '../../../domain/appleReminders';
import { defaultSpaceFor } from '../../../domain/spaceRules';
import type { SpaceId } from '../../../domain/types';
import { logFailure } from '../../../platform/desktop/log';
import type { AppContainer } from '../../app/container';
import { useAppStore } from '../../app/appStore';
import { appleRemindersState, appleRemindersStore, applyBanner } from './appleRemindersState';
import { resolveHeldList, type HeldChoice, type PassReport } from './remindersPass';
import { getRemindersRunner } from './remindersRunner';

/**
 * Gestes de l'écran « Rappels Apple » de l'iPhone (K-05, ADR 0008 §10.3) : état de l'accès, demande d'accès (seulement sur le geste),
 * listes d'Apple, listes affichées avec leur espace (ES-06 : prérempli Pro, une liste affichée sans espace est refusée), actualisation
 * (un passage `full` par le coordinateur), messages, suppressions retenues. Les réglages sont écrits par `appleRemindersState` ; les
 * écritures des tâches par les passages.
 */
export interface AppleRemindersActions {
  /** Relit l'accès du système (et les listes si l'accès est complet). Ne rejette jamais. */
  refreshAccess(): Promise<void>;
  /** Fenêtre iOS d'accès aux Rappels, seulement sur ce geste ; puis un passage si l'accès est accordé. */
  requestAccess(): Promise<void>;
  loadPlatformLists(): Promise<void>;
  setShown(list: ReminderList, shown: boolean): Promise<void>;
  setSpace(list: ReminderList, spaceId: SpaceId): Promise<void>;
  refresh(): Promise<PassReport>;
  dismissNotice(kind: AppleNoticeKind): Promise<void>;
  resolveHeld(listId: string, choice: HeldChoice): Promise<void>;
}

const actions = new WeakMap<AppContainer, AppleRemindersActions>();

export function appleRemindersActions(container: AppContainer): AppleRemindersActions {
  let known = actions.get(container);
  if (known === undefined) {
    known = createActions(container);
    actions.set(container, known);
  }
  return known;
}

function createActions(container: AppContainer): AppleRemindersActions {
  const store = appleRemindersStore.get(container);
  const state = appleRemindersState(container);

  const setRunning = (running: boolean): void => store.setState({ running });

  const loadPlatformLists = async (): Promise<void> => {
    try {
      const lists = await container.reminders.lists();
      store.setState({ platformLists: lists });
    } catch {
      logFailure('apple-reminders', 'lists-failed');
      store.setState({ platformLists: [], message: 'save-failed' });
      await state.fail('store-unavailable');
    }
  };

  const refreshAccess = async (): Promise<void> => {
    await state.load();
    if (!container.reminders.available) return;
    try {
      const access = await container.reminders.status();
      store.setState({ access });
      if (access === 'full') await loadPlatformLists();
      // Accès rétabli (réglages d'iOS) : l'état et le bandeau d'accès refusé disparaissent à la reprise.
      if (access === 'full' && store.getState().status.failure?.code === 'access-denied') await state.clearFailure();
      if (access !== 'full' && access !== 'not-determined' && store.getState().status.failure?.code !== 'access-denied') await state.fail('access-denied');
    } catch {
      logFailure('apple-reminders', 'status-failed');
      store.setState({ access: null });
      await state.fail('store-unavailable');
    }
    applyBanner(container);
  };

  const run = async (): Promise<PassReport> => {
    setRunning(true);
    try {
      return await getRemindersRunner(container).request('manual');
    } finally {
      setRunning(false);
    }
  };

  const writeList = async (list: ReminderList, change: (current: AppleListSetting) => AppleListSetting): Promise<boolean> => {
    await state.load();
    const lists = store.getState().lists.lists;
    const existing = lists.find((entry) => entry.id === list.id) ?? { id: list.id, name: list.name, spaceId: null, shown: false };
    const next = change({ ...existing, name: list.name.slice(0, 200) });
    // ES-06 : une liste affichée sans espace est refusée.
    if (next.shown && next.spaceId === null) {
      store.setState({ message: 'space-required' });
      return false;
    }
    if (lists.length >= MAX_APPLE_LISTS && !lists.some((entry) => entry.id === list.id)) {
      store.setState({ message: 'save-failed' });
      return false;
    }
    store.setState({ message: null });
    await state.setLists({ lists: [...lists.filter((entry) => entry.id !== list.id), next] });
    if (store.getState().persistFailed) store.setState({ message: 'save-failed' });
    return true;
  };

  return {
    refreshAccess,
    async requestAccess() {
      await state.load();
      try {
        const access = await container.reminders.requestAccess();
        store.setState({ access });
        if (access === 'full') {
          await state.clearFailure();
          await loadPlatformLists();
          void run();
        } else {
          await state.fail('access-denied');
        }
      } catch {
        logFailure('apple-reminders', 'request-failed');
        await state.fail('store-unavailable');
      }
      applyBanner(container);
    },
    loadPlatformLists,
    async setShown(list, shown) {
      const spaces = useAppStore.getState().spaces;
      const ok = await writeList(list, (current) => ({ ...current, shown, spaceId: shown && current.spaceId === null ? defaultSpaceFor('all', spaces) : current.spaceId }));
      if (ok) void run();
    },
    async setSpace(list, spaceId) {
      const ok = await writeList(list, (current) => ({ ...current, spaceId }));
      if (ok) void run();
    },
    refresh: run,
    async dismissNotice(kind) {
      await state.patchStatus((current) => ({ ...current, notices: current.notices.filter((entry) => entry.kind !== kind) }));
    },
    async resolveHeld(listId, choice) {
      setRunning(true);
      try {
        await resolveHeldList(container, listId, choice);
      } finally {
        setRunning(false);
      }
    },
  };
}
