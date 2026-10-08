import { createStore } from 'zustand';
import {
  EMPTY_APPLE_CREATE,
  EMPTY_APPLE_LISTS,
  EMPTY_APPLE_STATUS,
  LAST_PASS_WRITE_INTERVAL_MS,
  MAX_NOTICES,
  parseAppleCreate,
  parseAppleLists,
  parseApplePending,
  parseAppleStatus,
  parseLastPassAt,
  type AppleCreateSetting,
  type AppleListsSetting,
  type AppleNotice,
  type ApplePending,
  type AppleStatus,
  type RemindersAccess,
  type ReminderList,
} from '../../../domain/appleReminders';
import { nowIso } from '../../../domain/clock';
import type { IsoDateTime } from '../../../domain/types';
import { t } from '../../../i18n';
import { logFailure } from '../../../platform/desktop/log';
import { useAppStatusStore } from '../../app/appStatus';
import { defineFeatureStore, type AppContainer } from '../../app/container';
import { useNavigationStore } from '../../app/navigation';

/**
 * État des Rappels Apple (K-05 à K-07, ADR 0008 §10.3) : réglages partagés (`appleReminders.lists`, `.create`, `.lastPassAt`, `.pending`)
 * et réglage LOCAL `appleReminders.status` (échec persistant, plafonds, suppressions retenues, liens inconnus, messages), tous relus par
 * leurs analyseurs (une valeur venue de la synchro n'est jamais crue). Un seul écrivain par réglage : ce module. Une écriture de
 * `appleReminders.*` ne déclenche jamais de passage (pas de boucle). Jamais un titre de rappel dans l'état local ni dans un journal :
 * des codes et des nombres.
 */

export interface AppleRemindersState {
  /** Les réglages ont été lus. */
  readonly loaded: boolean;
  /** Plugin disponible : iPhone installé. Faux sur PC (affichage en lecture seule, K-07). */
  readonly available: boolean;
  /** Accès du système ; null tant qu'il n'a pas été lu (ou indisponible). */
  readonly access: RemindersAccess | null;
  /** Listes d'Apple lues sur l'écran ou au passage ; vide sur PC. */
  readonly platformLists: readonly ReminderList[];
  readonly lists: AppleListsSetting;
  readonly create: AppleCreateSetting;
  readonly lastPassAt: IsoDateTime | null;
  readonly pending: ApplePending | null;
  readonly status: AppleStatus;
  /** Un passage est en cours sur cet appareil. */
  readonly running: boolean;
  /** Dernière écriture d'un réglage impossible : l'état n'est que dans la mémoire de cette session (visible). */
  readonly persistFailed: boolean;
  /** Dernière action de l'écran refusée (texte), effacée à l'action suivante. */
  readonly message: 'space-required' | 'save-failed' | 'no-list' | 'list-not-in-space' | null;
}

export const appleRemindersStore = defineFeatureStore<AppleRemindersState>(() =>
  createStore<AppleRemindersState>()(() => ({
    loaded: false,
    available: false,
    access: null,
    platformLists: [],
    lists: EMPTY_APPLE_LISTS,
    create: EMPTY_APPLE_CREATE,
    lastPassAt: null,
    pending: null,
    status: EMPTY_APPLE_STATUS,
    running: false,
    persistFailed: false,
    message: null,
  })),
);

export interface AppleRemindersController {
  load(): Promise<void>;
  /** Relit les réglages (après une synchro reçue, pour le PC). */
  reload(): Promise<void>;
  setLists(next: AppleListsSetting): Promise<void>;
  setCreate(next: AppleCreateSetting): Promise<void>;
  /** `force` : le passage a envoyé des écritures vers Rappels ; le PC en déduit que « sera envoyée au prochain passage » est levé (K-07 D2). */
  setLastPassAt(at: IsoDateTime, nowMs: number, force?: boolean): Promise<void>;
  setPending(count: number): Promise<void>;
  /** Accès du système et listes d'Apple lus par un passage : l'écran les montre sans relancer sa propre lecture. */
  setObserved(access: RemindersAccess, platformLists?: readonly ReminderList[]): void;
  patchStatus(change: (current: AppleStatus) => AppleStatus): Promise<void>;
  fail(code: string): Promise<void>;
  clearFailure(): Promise<void>;
  addNotice(notice: Omit<AppleNotice, 'at'>): Promise<void>;
}

const controllers = new WeakMap<AppContainer, AppleRemindersController>();

/** Contrôleur des réglages de ce conteneur (écritures sérialisées : deux mises à jour rapprochées ne s'écrasent jamais). */
export function appleRemindersState(container: AppContainer): AppleRemindersController {
  let known = controllers.get(container);
  if (known === undefined) {
    known = createController(container);
    controllers.set(container, known);
  }
  return known;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function createController(container: AppContainer): AppleRemindersController {
  const store = appleRemindersStore.get(container);
  let chain: Promise<void> = Promise.resolve();
  let loading: Promise<void> | null = null;
  /** Dernière valeur de `lastPassAt` ÉCRITE en base (l'affichage de la session peut être plus récent). */
  let writtenLastPassAt: IsoDateTime | null = null;

  const readAll = async (): Promise<void> => {
    const settings = container.data.repos.settings;
    const [lists, create, lastPassAt, pending, status] = await Promise.all([
      settings.get('appleReminders.lists'),
      settings.get('appleReminders.create'),
      settings.get('appleReminders.lastPassAt'),
      settings.get('appleReminders.pending'),
      settings.get('appleReminders.status'),
    ]);
    writtenLastPassAt = parseLastPassAt(lastPassAt);
    store.setState({
      loaded: true,
      available: container.reminders.available,
      lists: parseAppleLists(lists),
      create: parseAppleCreate(create),
      lastPassAt: parseLastPassAt(lastPassAt),
      pending: parseApplePending(pending),
      status: parseAppleStatus(status),
    });
    applyBanner(container);
  };

  const load = (): Promise<void> => {
    loading ??= readAll().catch(() => {
      loading = null;
      logFailure('apple-reminders', 'settings-unreadable');
      // Visible : un échec de lecture est un échec de Rappels (état persistant), pas un silence.
      store.setState({ loaded: true, available: container.reminders.available, status: { ...EMPTY_APPLE_STATUS, failure: { code: 'settings-unreadable', at: nowIso(container.clock) } } });
      applyBanner(container);
    });
    return loading;
  };

  /** Écrit un réglage (sérialisé) ; en cas d'échec, l'état reste en mémoire et `persistFailed` le dit. */
  const persist = (write: () => Promise<void>): Promise<void> => {
    const run = chain.then(async () => {
      try {
        await write();
        if (store.getState().persistFailed) store.setState({ persistFailed: false });
      } catch {
        store.setState({ persistFailed: true });
        logFailure('apple-reminders', 'settings-write-failed');
      }
    });
    chain = run;
    return run;
  };

  const settings = (): AppContainer['data']['repos']['settings'] => container.data.repos.settings;

  const patchStatus = async (change: (current: AppleStatus) => AppleStatus): Promise<void> => {
    await load();
    const before = store.getState().status;
    const next = change(before);
    if (same(next, before) && !store.getState().persistFailed) return;
    store.setState({ status: next });
    applyBanner(container);
    await persist(() => settings().set('appleReminders.status', next));
  };

  return {
    load,
    async reload() {
      loading = null;
      await load();
    },
    async setLists(next) {
      await load();
      if (same(next, store.getState().lists) && !store.getState().persistFailed) return;
      store.setState({ lists: next });
      await persist(() => settings().set('appleReminders.lists', next));
    },
    async setCreate(next) {
      await load();
      if (same(next, store.getState().create) && !store.getState().persistFailed) return;
      store.setState({ create: next });
      await persist(() => settings().set('appleReminders.create', next));
    },
    async setLastPassAt(at, nowMs, force = false) {
      await load();
      // Une écriture au plus tous les 15 minutes (K-05 critère 14) ; l'affichage de cette session suit toujours.
      store.setState({ lastPassAt: at });
      if (!force && writtenLastPassAt !== null && nowMs - Date.parse(writtenLastPassAt) < LAST_PASS_WRITE_INTERVAL_MS) return;
      writtenLastPassAt = at;
      await persist(() => settings().set('appleReminders.lastPassAt', at));
    },
    async setPending(count) {
      await load();
      const before = store.getState().pending;
      // Écrite seulement quand le nombre change (ADR 0008 §10.3) ; zéro : la valeur est retirée.
      if ((before?.count ?? 0) === count) return;
      const next: ApplePending | null = count === 0 ? null : { count, at: nowIso(container.clock) };
      store.setState({ pending: next });
      applyBanner(container);
      await persist(() => settings().set('appleReminders.pending', next));
    },
    patchStatus,
    setObserved(access, platformLists) {
      store.setState({ access, ...(platformLists === undefined ? {} : { platformLists }) });
    },
    async fail(code) {
      await patchStatus((s) => ({ ...s, failure: { code, at: nowIso(container.clock) } }));
    },
    async clearFailure() {
      await patchStatus((s) => (s.failure === null ? s : { ...s, failure: null }));
    },
    async addNotice(notice) {
      await patchStatus((s) => {
        const merged = s.notices.filter((entry) => !(entry.kind === notice.kind && entry.listId === notice.listId));
        const next: AppleNotice = { ...notice, at: nowIso(container.clock) };
        return { ...s, notices: [next, ...merged].slice(0, MAX_NOTICES) };
      });
    },
  };
}

/** L'échec persistant vient d'une écriture vers Rappels (le bandeau parle alors de modifications non envoyées). */
export const isWriteFailure = (failure: AppleStatus['failure']): boolean => failure !== null && failure.write === true;

/** Pose (ou retire) l'état A-09 `appleRemindersTrouble` : échec de lecture, accès refusé, ou modifications non envoyées. */
export function applyBanner(container: AppContainer): void {
  const state = appleRemindersStore.get(container).getState();
  const failure = state.status.failure;
  const setStatus = useAppStatusStore.getState().setStatus;
  if (failure === null || !state.available) {
    setStatus('appleRemindersTrouble', null);
    return;
  }
  const count = state.pending?.count ?? 0;
  const message = failure.code === 'access-denied' ? t('appleReminders.bannerAccess') : isWriteFailure(failure) && count > 0 ? t('appleReminders.bannerWrite', { count }) : t('appleReminders.bannerRead');
  setStatus('appleRemindersTrouble', { detail: failure.code, message, onAction: () => useNavigationStore.getState().navigate({ tab: 'settings', screen: 'calendars' }) });
}

/** Retire le bandeau (démontage de l'intégration). */
export function clearBanner(): void {
  useAppStatusStore.getState().setStatus('appleRemindersTrouble', null);
}
