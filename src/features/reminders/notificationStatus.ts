import { createStore } from 'zustand';
import { nowIso } from '../../domain/clock';
import { EMPTY_NOTIFICATION_STATUS, parseNotificationStatus, type NotificationStatusV1, type PlanFailureReason, type StatusReport } from '../../domain/notificationStatus';
import { t } from '../../i18n';
import { logFailure } from '../../platform/desktop/log';
import { NotificationSchedulerError } from '../../platform/notifications';
import { useAppStatusStore } from '../app/appStatus';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { useNavigationStore } from '../app/navigation';

/**
 * État persistant des rappels (N-01 critère 12, ADR 0012 avenant N1.3 et N1.8) : réglage LOCAL `notifications.status`, lu avant le
 * premier passage (le bandeau survit à un redémarrage), écrit à chaque changement, effacé à la résolution (premier `replace` réussi,
 * autorisation accordée, prochaine planification de la fin de Focus). Si l'écriture est impossible, l'état reste dans le store pour la
 * session (visible) et l'écriture est retentée au changement suivant. Jamais un titre ni un texte de rappel : codes et nombres.
 */

export type NotificationAvailabilityState = 'available' | 'unavailable' | null;

export interface NotificationStatusState {
  readonly status: NotificationStatusV1;
  /** Lu en base (ou illisible) : le premier passage attend `load()`. */
  readonly loaded: boolean;
  /** Réponse du planificateur au dernier passage : `unavailable` sur le PC (« envoyés par l'iPhone »), null avant le premier passage. */
  readonly availability: NotificationAvailabilityState;
  /** Dernière écriture du réglage impossible : l'état n'est que dans la mémoire de cette session. */
  readonly persistFailed: boolean;
}

export const notificationStatusStore = defineFeatureStore<NotificationStatusState>(() =>
  createStore<NotificationStatusState>()(() => ({ status: EMPTY_NOTIFICATION_STATUS, loaded: false, availability: null, persistFailed: false })),
);

/** Le téléphone installé : seul endroit où `unavailable` est une panne (sur le PC et en navigateur, c'est l'état normal). */
export const isInstalledIphone = (container: Pick<AppContainer, 'platform'>): boolean => container.platform.runtime === 'tauri' && container.platform.os === 'ios';

/** Raison d'un échec de `replace` (jamais un message), `schedule-failed` pour toute exception inattendue. */
export function failureOf(error: unknown): { reason: PlanFailureReason; count: number; partial: StatusReport | null } {
  if (error instanceof NotificationSchedulerError) return { reason: error.reason, count: error.ids.length, partial: error.partial };
  return { reason: 'schedule-failed', count: 0, partial: null };
}

export interface StatusController {
  /** Lit le réglage une fois (idempotent). Ne rejette jamais ; une valeur illisible devient un échec visible. */
  load(): Promise<void>;
  get(): NotificationStatusV1;
  /** Remplace l'état par `change(état)`, l'écrit s'il a changé, met à jour le bandeau. Ne rejette jamais. */
  patch(change: (current: NotificationStatusV1) => NotificationStatusV1): Promise<void>;
  setAvailability(value: NotificationAvailabilityState): void;
}

const controllers = new WeakMap<AppContainer, StatusController>();

export function statusController(container: AppContainer): StatusController {
  let known = controllers.get(container);
  if (known === undefined) {
    known = createStatusController(container);
    controllers.set(container, known);
  }
  return known;
}

function createStatusController(container: AppContainer): StatusController {
  const store = notificationStatusStore.get(container);
  let loading: Promise<void> | null = null;
  // Les écritures se suivent : deux patchs rapprochés ne s'écrasent jamais.
  let chain: Promise<void> = Promise.resolve();

  const syncBanner = (): void => applyReminderBanner(container);

  const load = (): Promise<void> => {
    loading ??= (async () => {
      let raw: unknown = null;
      let readable = true;
      try {
        raw = await container.data.repos.settings.get('notifications.status');
      } catch {
        readable = false;
      }
      const parsed = readable ? parseNotificationStatus(raw) : ({ state: 'unreadable' } as const);
      if (parsed.state === 'valid') {
        store.setState({ status: parsed.status, loaded: true });
      } else {
        logFailure('notifications', 'status-unreadable');
        // Affichée comme un échec de planification jusqu'au passage réussi suivant, qui la réécrit (avenant N1.3).
        store.setState({ status: { ...EMPTY_NOTIFICATION_STATUS, planFailure: { at: nowIso(container.clock), reason: 'schedule-failed', count: 0, partial: null } }, loaded: true });
      }
      syncBanner();
    })();
    return loading;
  };

  return {
    load,
    get: () => store.getState().status,
    setAvailability: (value) => {
      store.setState({ availability: value });
      syncBanner();
    },
    patch: (change) => {
      const run = chain.then(async () => {
        await load();
        const before = store.getState().status;
        const next = change(before);
        if (JSON.stringify(next) === JSON.stringify(before) && !store.getState().persistFailed) return;
        store.setState({ status: next });
        syncBanner();
        try {
          await container.data.repos.settings.set('notifications.status', next);
          store.setState({ persistFailed: false });
        } catch {
          store.setState({ persistFailed: true });
          logFailure('notifications', 'status-write-failed');
        }
      });
      chain = run;
      return run;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Problèmes affichés (bandeau et Réglages > Rappels)
// ---------------------------------------------------------------------------------------------------------------------------------

export type ProblemCode = 'permission-denied' | 'undetermined' | 'unavailable' | 'plan-failed' | 'focus-end-failed' | 'zone-unknown';

export interface ReminderProblem {
  readonly code: ProblemCode;
  readonly text: string;
}

/**
 * Les états à montrer, du plus important au moins important (avenant N1.8) : autorisation refusée, autorisation non décidée,
 * indisponible sur iPhone, échec du plan, fin de Focus, fuseau illisible. Vide sur le PC et en navigateur (jamais de bandeau de
 * planification : « Les rappels sont envoyés par l'iPhone »).
 */
export function reminderProblems(state: Pick<NotificationStatusState, 'status' | 'availability'>, iphone: boolean): ReminderProblem[] {
  const { status, availability } = state;
  // Avant le premier passage (redémarrage), les problèmes ENREGISTRÉS sont déjà montrés : le bandeau survit au redémarrage.
  if (availability === 'unavailable' && !iphone) return [];
  const out: ReminderProblem[] = [];
  if (availability === 'unavailable') {
    out.push({ code: 'unavailable', text: t('reminders.status.unavailable') });
  } else {
    if (status.permission === 'denied') out.push({ code: 'permission-denied', text: t('reminders.status.permissionDeniedBanner') });
    if (status.permission === 'undetermined') out.push({ code: 'undetermined', text: t('reminders.status.permissionUndetermined') });
  }
  const failure = status.planFailure;
  const duplicate = failure !== null && ((failure.reason === 'permission-denied' && status.permission === 'denied') || (failure.reason === 'unavailable' && availability === 'unavailable'));
  if (failure !== null && failure.reason !== 'zone-unknown' && !duplicate) out.push({ code: 'plan-failed', text: t('reminders.status.planFailed') });
  if (status.focusEndFailure !== null) out.push({ code: 'focus-end-failed', text: t('reminders.status.focusEndFailed') });
  if (failure !== null && failure.reason === 'zone-unknown') out.push({ code: 'zone-unknown', text: t('reminders.status.zoneUnknown') });
  return out;
}

/** Pose (ou retire) le bandeau `remindersTrouble` selon l'état courant. */
export function applyReminderBanner(container: AppContainer): void {
  const state = notificationStatusStore.get(container).getState();
  const problems = reminderProblems(state, isInstalledIphone(container));
  const first = problems[0];
  if (first === undefined) {
    useAppStatusStore.getState().setStatus('remindersTrouble', null);
    return;
  }
  useAppStatusStore.getState().setStatus('remindersTrouble', {
    detail: first.code === 'undetermined' ? 'undetermined' : first.code,
    message: first.text,
    more: problems.length - 1,
    onAction: first.code === 'undetermined' ? () => void import('./requestPermission').then((module) => module.requestPermissionOnGesture(container)) : () => useNavigationStore.getState().navigate({ tab: 'settings', screen: 'reminders' }),
  });
}

/** Retire le bandeau (démontage de l'intégration). */
export function clearReminderBanner(): void {
  useAppStatusStore.getState().setStatus('remindersTrouble', null);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Fin de Focus (F-04 critère 15)
// ---------------------------------------------------------------------------------------------------------------------------------

/** La notification de fin de session n'a pas pu être planifiée : écrit l'échec (session, code, heure ; jamais le titre). */
export async function reportFocusEndFailure(container: AppContainer, sessionId: string, error: unknown): Promise<void> {
  const { reason } = failureOf(error);
  logFailure('notifications', `focus-end-failed ${reason}`);
  await statusController(container).patch((s) => ({ ...s, focusEndFailure: { at: nowIso(container.clock), sessionId, reason } }));
}

/** Efface l'échec de fin de Focus (prochain `schedule` ou `cancel` réussi, clôture de la session). Sans effet s'il n'y en a pas. */
export async function clearFocusEndFailure(container: AppContainer): Promise<void> {
  if (notificationStatusStore.get(container).getState().status.focusEndFailure === null) return;
  await statusController(container).patch((s) => ({ ...s, focusEndFailure: null }));
}
