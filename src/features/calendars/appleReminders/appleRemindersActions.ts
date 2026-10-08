import { MAX_APPLE_LISTS, validateCreateRule, type AppleListSetting, type AppleNoticeKind, type ReminderList } from '../../../domain/appleReminders';
import { defaultSpaceFor } from '../../../domain/spaceRules';
import type { SpaceId } from '../../../domain/types';
import { logFailure } from '../../../platform/desktop/log';
import type { AppContainer } from '../../app/container';
import { useAppStore } from '../../app/appStore';
import { appleRemindersState, appleRemindersStore, applyBanner } from './appleRemindersState';
import { resolveHeldList, type HeldChoice, type PassReport } from './remindersPass';
import { withExcursion } from '../../security/excursion';
import { openAppSettings } from '../../../platform/systemSettings';
import { resolveHeldSend } from './remindersWrites';
import { detachUnlisted, resetLists } from './appleListRepairs';
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
  /**
   * Réglage « Créer aussi dans Rappels » d'un espace (K-06 critère 6) : désactivé par défaut ; activer sans liste affichée de cet espace est
   * refusé avec la raison (`message`). La liste de destination est choisie parmi les listes affichées de l'espace.
   */
  setCreateRule(spaceId: SpaceId, enabled: boolean, listId: string | null): Promise<void>;
  refresh(): Promise<PassReport>;
  /** Gestes de l'échec `lists-setting-invalid` (aucune impasse). */
  detachUnlisted(): Promise<void>;
  /** Réglages d'iOS (excursion gardée jusqu'au retour dans l'app). */
  openSettings(): Promise<void>;
  /** Efface l'échec persistant affiché (« Ignorer »). */
  ignoreFailure(): Promise<void>;
  resetLists(): Promise<void>;
  dismissNotice(kind: AppleNoticeKind): Promise<void>;
  /** `send` : retenue de suppressions vers Rappels (tâches supprimées ici) ; sinon retenue de rappels absents de Rappels. */
  resolveHeld(listId: string, choice: HeldChoice, send?: boolean, expected?: number): Promise<void>;
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

  /**
   * Décocher la liste de destination d'un espace (ou la changer d'espace) désactive le réglage de création de cet espace et le dit (K-06 critère 6).
   */
  const reconcileCreateRules = async (): Promise<void> => {
    const { lists, create } = store.getState();
    const broken = create.bySpace.filter((rule) => rule.enabled && validateCreateRule(rule.spaceId, rule.listId, lists) !== null);
    if (broken.length === 0) return;
    await state.setCreate({ bySpace: create.bySpace.map((rule) => (broken.includes(rule) ? { ...rule, enabled: false } : rule)) });
    await state.addNotice({ kind: 'creation-off', count: broken.length });
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
    await reconcileCreateRules();
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
    async setCreateRule(spaceId, enabled, listId) {
      await state.load();
      const { lists, create } = store.getState();
      if (enabled) {
        const issue = validateCreateRule(spaceId, listId, lists);
        if (issue !== null) {
          store.setState({ message: issue });
          return;
        }
      }
      store.setState({ message: null });
      const others = create.bySpace.filter((rule) => rule.spaceId !== spaceId);
      await state.setCreate({ bySpace: [...others, { spaceId, enabled, listId }] });
      if (store.getState().persistFailed) store.setState({ message: 'save-failed' });
    },
    refresh: run,
    async openSettings() {
      try {
        await withExcursion('system-settings', () => openAppSettings());
      } catch {
        logFailure('apple-reminders', 'open-settings-failed');
        store.setState({ message: 'save-failed' });
      }
    },
    async ignoreFailure() {
      await state.clearFailure();
    },
    async detachUnlisted() {
      setRunning(true);
      try {
        await detachUnlisted(container);
      } finally {
        setRunning(false);
      }
    },
    async resetLists() {
      setRunning(true);
      try {
        await resetLists(container);
      } finally {
        setRunning(false);
      }
    },
    async dismissNotice(kind) {
      await state.patchStatus((current) => ({ ...current, notices: current.notices.filter((entry) => entry.kind !== kind) }));
    },
    async resolveHeld(listId, choice, send = false, expected) {
      setRunning(true);
      try {
        if (send) {
          const report = await resolveHeldSend(container, listId, choice, expected);
          // Écritures encore dans la fenêtre d'annulation de 5 s : le passage `push` est reprogrammé, aucun second geste n'est nécessaire.
          if (report.holdMs !== undefined) {
            const { getRemindersRunner } = await import('./remindersRunner');
            void getRemindersRunner(container).request('edit');
          }
        }
        else await resolveHeldList(container, listId, choice);
      } finally {
        setRunning(false);
      }
    },
  };
}
