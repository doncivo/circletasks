import type { AppStatusKind } from '../../domain/appStatus';
import { newerDevices } from '../../domain/sync/compat';
import { isSyncErrorCode } from '../../domain/sync/format';
import { QUIT_HANDLER_SYNC_MS, SYNCING_BANNER_DELAY_MS } from '../../domain/sync/limits';
import { phaseBanner, syncBannerFor, type BlockingPhaseFact, type PersistedSyncFacts, type SyncTrouble } from '../../domain/syncBanners';
import type { DeviceId } from '../../domain/types';
import { t } from '../../i18n';
import { logFailure } from '../../platform/desktop/log';
import type { RemoteChanges, SyncDeviceStatus, SyncStatus } from '../../platform/sync/types';
import { remindersHidePass } from '../calendars/appleReminders/hidePass';
import { HIDE_SYNC_DEADLINE_MS, readForgetStatus, readResetStatus, readStoredDeviceStatuses, startSyncScheduler, type SyncSchedulerEnv } from '../../sync';
import { useAppStatusStore, type StatusSource } from '../app/appStatus';
import type { AppContainer } from '../app/container';
import { useNavigationStore } from '../app/navigation';
import { clearMarkerFailedMemo, peekMarkerFailedCode } from '../settings/restoreMemoPeek';
import { onPairingChange, readJoinFailure } from './pairingStatus';
import { applyRemoteChanges } from './remoteChanges';
import { clearReloadRetry, coversChanges, mergeChanges, setReloadRetry } from './reloadRetry';
import { syncStore } from './syncStore';
import { markerFailures, schedulers } from './syncRestoreState';
import { deviceName, deviceStatusText, formatCount, statusLine, waitingLong, warningText } from './syncText';
import { forgetFailureText, forgetPendingBanner } from './forgetText';
import { resetProgressBanner, resetReminderText } from './resetText';

export interface SyncIntegration {
  dispose(): void;
  /** Se résout quand la dernière relecture des états persistés est appliquée (tests : aucune attente par délai). */
  refreshed(): Promise<void>;
  /** Y-TECH-02 : se résout quand le dernier rechargement des écrans après un lot reçu est terminé (tests). */
  reloaded(): Promise<void>;
}

/** Environnement injectable (tests : document, horloge et minuteries factices ; aucun délai réel). */
export interface SyncIntegrationEnv extends Partial<SyncSchedulerEnv> {
  /** Minuteur du seuil de « Synchro en cours » (A-09 critère 9 d). */
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}


/** États A-09 posés par la synchro, tous retirés à `dispose()` (critère 9 j). */
const SYNC_KINDS = ['syncTrouble', 'updateRequired', 'waitingIcloud', 'syncing'] as const satisfies readonly AppStatusKind[];

/**
 * Clé de `sync_meta` de la dernière phase bloquante d'un cycle conclu (revue A-09, point 7) : codes seulement (phase, code d'erreur,
 * identifiant d'appareil), jamais de contenu. Écrite et effacée par l'interface ; le moteur ne la lit pas. `restore-choice` n'y est
 * jamais écrite : le marqueur de restauration persisté en tient lieu.
 */
export const BLOCKING_PHASE_META = 'bannerBlockingPhase';

/**
 * Texte d'un état `syncTrouble` (A-09 D5 : une seule formulation par état) : ligne de Réglages (`statusLine`) de l'état qui le porte
 * (`textStatus` de `syncBannerFor`), texte de l'arrivée en échec de `JoinProgress` (Y-06), appareil nommé et statut comme dans APPAREILS.
 */
export function syncTroubleText(trouble: SyncTrouble<SyncDeviceStatus>, textStatus: SyncStatus, devices: readonly SyncDeviceStatus[], nowMs: number): string {
  switch (trouble.code) {
    case 'join-failed':
      return trouble.join.failure === 'clock-ahead'
        ? t('sync.pairing.joinFailedClock')
        : t('sync.pairing.joinFailed', { done: formatCount(trouble.join.done), total: formatCount(trouble.join.total) });
    case 'device-foreign':
    case 'device-corrupt':
    case 'device-rollback':
      return t('status.syncDevice', { device: deviceName(trouble.device, devices), state: deviceStatusText(trouble.device) });
    case 'state-unreadable':
      return t('status.syncStateUnreadable');
    case 'reload-failed':
      return t('status.syncReloadFailed');
    case 'key-mismatch':
      // Phase `key-mismatch`, ou déduite des appareils avant le premier cycle (même texte).
      return textStatus.phase === 'key-mismatch' ? statusLine(textStatus, nowMs) : t('sync.status.keyMismatch');
    case 'needs-pairing':
    case 'restore-choice':
    case 'error':
    case 'clock-ahead':
    case 'forgotten':
    case 'reset-required':
      return statusLine(textStatus, nowMs);
    // Y-10 : mêmes textes que l'emplacement `forget` et la ligne APPAREILS de Réglages, appareils nommés comme dans APPAREILS.
    case 'forget-failed':
      return forgetFailureText(trouble.failure, devices);
    case 'forget-pending':
      return forgetPendingBanner(trouble.deletion, devices);
    // Y-11 : mêmes textes que l'emplacement `reset` de Réglages (étape, échec, rappel des 30 jours).
    case 'reset-progress':
      return resetProgressBanner(trouble.reset, devices);
    case 'reset-reminder':
      return resetReminderText(trouble.reset.waiting, devices);
    // Y-TECH-02 : avertissements du scan, même texte que la section AVERTISSEMENTS des détails.
    case 'nonce-budget':
    case 'folder-large':
    case 'too-many-devices':
    case 'scan-incomplete':
      return warningText(trouble.code);
  }
}

/** Phase bloquante d'un état conclu à garder (null : aucune ; `restore-choice` : le marqueur suffit). */
function blockingOf(status: SyncStatus): BlockingPhaseFact | null {
  const decision = phaseBanner(status.phase);
  if (decision.kind !== 'trouble' || decision.code === 'restore-choice') return null;
  return { phase: decision.code, errorCode: status.errorCode ?? null, clockAheadDevice: (status.clockAheadDevice as DeviceId | null | undefined) ?? null };
}

/** Valeur gardée relue ; une valeur mal formée est ignorée (écrite par une autre version), jamais une panne. */
function parseBlocking(raw: string | null): BlockingPhaseFact | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { phase, errorCode, clockAheadDevice } = value as Record<string, unknown>;
  if (phase !== 'needs-pairing' && phase !== 'key-mismatch' && phase !== 'error' && phase !== 'clock-ahead' && phase !== 'forgotten' && phase !== 'reset-required') return null;
  return {
    phase,
    errorCode: isSyncErrorCode(errorCode) ? errorCode : null,
    clockAheadDevice: typeof clockAheadDevice === 'string' ? (clockAheadDevice as DeviceId) : null,
  };
}

/**
 * Branche la synchro sur l'app (Y-02 critères 1, 17 et 18) : planificateur (ouverture, 5 min fenêtre visible, masquage), bandeaux A-09
 * et rechargement des stores après chaque lot reçu. Sans synchro (`container.sync` null) : rien, aucun coût.
 *
 * Bandeaux (A-09 critère 9, décision de `syncBanners.ts`) : `syncTrouble` (phase en échec ou bloquée, état local illisible, arrivée en
 * échec, appareils `foreign` / `corrupt` / `rollback`, le plus urgent avec « (+N) » et « Voir »), « En attente d'iCloud » (avec sa
 * cause), « Synchro en cours » (au-delà du seuil compté depuis le début du cycle), « Mettez à jour l'app » (Y-07). « Hors ligne » n'est
 * jamais retiré ici.
 *
 * États persistés : relus au démarrage, à chaque changement de phase, à la conclusion d'un cycle et sur un changement d'association.
 * Avant le premier cycle conclu : appareils (`sync_state`), dernière phase bloquante (`sync_meta`) et marqueur de restauration. Une
 * lecture en échec garde les valeurs précédentes et pose `state-unreadable` jusqu'à la lecture réussie suivante (critère 9 i).
 */
export function startSyncIntegration(container: AppContainer, env: SyncIntegrationEnv = {}): SyncIntegration {
  const sync = container.sync;
  if (!sync) return { dispose: () => undefined, refreshed: () => Promise.resolve(), reloaded: () => Promise.resolve() };
  const setTimer = env.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimer = env.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const repos = container.data.repos;
  let disposed = false;
  let persisted: PersistedSyncFacts<SyncDeviceStatus> = { join: null, devices: null, blocking: null, readFailed: false };
  let writeFailed = false;
  /** Y-TECH-02 (revue, point 2) : dernier rechargement des écrans après un lot reçu en échec (bandeau `reload-failed`). */
  let reloadFailed = false;
  let lastReload: Promise<void> = Promise.resolve();
  /** Un cycle a conclu depuis le démarrage : l'état exposé fait foi pour les appareils et la phase. */
  let concluded = false;
  /** Dernier état hors cycle (bandeaux de phase gardés pendant le cycle suivant). */
  let settled: SyncStatus | null = null;
  let lastPhase: SyncStatus['phase'] | null = null;
  /** Valeur de `BLOCKING_PHASE_META` connue (texte JSON ou null) ; undefined : pas encore lue ni écrite. */
  let storedBlocking: string | null | undefined;
  let syncingTimer: unknown = null;
  let syncingShown = false;
  /** Début d'une phase `syncing` vue sans `cycleStartedAt` (service qui ne le publie pas). */
  let syncingSeenAt: number | null = null;
  let readSeq = 0;
  /** Lectures en cours (elles peuvent se chevaucher) et relecture demandée pendant l'une d'elles (revue 2, point 2). */
  let activeReads = 0;
  let rereadPending = false;
  let lastRefresh: Promise<void> = Promise.resolve();
  let lastWrite: Promise<void> = Promise.resolve();

  const put = (kind: AppStatusKind, source: StatusSource | null): void => {
    const store = useAppStatusStore.getState();
    const previous = store.sources[kind];
    if (source === null) {
      if (previous !== undefined) store.setStatus(kind, null);
      return;
    }
    // Même état, même texte : rien ne change (aucun rendu ni clignotement).
    if (previous && previous.detail === source.detail && previous.message === source.message && previous.more === source.more) return;
    store.setStatus(kind, source);
  };

  const openSettings = (): void => useNavigationStore.getState().navigate({ tab: 'settings', screen: 'sync' });
  const actionFor = (trouble: SyncTrouble<SyncDeviceStatus>): (() => void) =>
    trouble.code === 'restore-choice' ? () => void syncStore.get(container).getState().openRestore() : openSettings;

  const stopSyncingTimer = (): void => {
    if (syncingTimer === null) return;
    clearTimer(syncingTimer);
    syncingTimer = null;
  };

  const showSyncing = (): void => {
    syncingShown = true;
    put('syncing', {});
  };

  const applyBanners = (): void => {
    if (disposed) return;
    const current = sync.status();
    const nowMs = container.clock.nowMs();
    const banners = syncBannerFor(current, { ...persisted, readFailed: persisted.readFailed || writeFailed, reloadFailed }, settled);

    const [first, ...others] = banners.troubles;
    const marker = markerFailures.get(container);
    // P-04-iOS critère 12 : la restauration est faite, mais la synchro n'est pas suspendue : ce bandeau prime tant qu'il n'est pas résolu.
    if (marker) put('syncTrouble', { detail: 'restore-marker-failed', message: `${t('backup.markerFailed')} ${t('backup.errorCode', { code: marker.code })}`, more: 0, onAction: openSettings });
    else if (first) put('syncTrouble', { detail: first.code, message: syncTroubleText(first, banners.textStatus, banners.devices, nowMs), more: others.length, onAction: actionFor(first) });
    else put('syncTrouble', null);

    // Critère 9 e : cause connue, texte de la ligne de Réglages (sans l'échec de réintégration, montré par `updateRequired`).
    // Audit (point bas 8) : attente prolongée, même sans cause connue : texte de la ligne de Réglages (vérifier iCloud et le dossier).
    const explained = banners.waitingIcloud && (banners.waitingIcloud.cause || waitingLong({ ...banners.textStatus, phase: 'waiting-icloud' }, nowMs));
    put('waitingIcloud', banners.waitingIcloud ? (explained ? { message: statusLine({ ...banners.textStatus, phase: 'waiting-icloud', reintegrationFailure: null }, nowMs) } : {}) : null);

    // Critère 9 d : un seul seuil, compté depuis le début du cycle (`cycleStartedAt` du service) ; jamais deux délais cumulés.
    if (banners.syncing) {
      syncingSeenAt ??= nowMs;
      if (!syncingShown && syncingTimer === null) {
        const remaining = SYNCING_BANNER_DELAY_MS - (nowMs - (current.cycleStartedAt ?? syncingSeenAt));
        if (remaining <= 0) showSyncing();
        else
          syncingTimer = setTimer(() => {
            syncingTimer = null;
            if (!disposed && sync.status().phase === 'syncing') showSyncing();
          }, remaining);
      }
    } else {
      stopSyncingTimer();
      syncingShown = false;
      syncingSeenAt = null;
      put('syncing', null);
    }

    // Y-07 critère 9 : tant qu'un autre appareil actif publie une version plus récente ; jamais sans synchro configurée.
    const configured = current.phase !== 'not-configured' && current.phase !== 'needs-pairing';
    // Exigence d'Ali : un échec de réintégration prime (rien d'autre ne le montre depuis l'écran principal) ; même état A-09.
    // L'échec vient du démarrage, pas de la synchro : signalé même sans synchro configurée (revue 2) ; un appareil plus récent, non.
    put('updateRequired', current.reintegrationFailure ? { detail: 'reintegration' } : configured && newerDevices(current.devices).length > 0 ? {} : null);
  };

  /** Repli visible (revue A-09, point 2) : une erreur pendant le calcul des bandeaux donne « La synchronisation a échoué », jamais rien. */
  const safely = (run: () => void): void => {
    try {
      run();
    } catch {
      logFailure('sync', 'banner-failed {"code":"io"}');
      if (!disposed) put('syncTrouble', { detail: 'error', message: t('sync.status.errorGeneric'), more: 0, onAction: openSettings });
    }
  };

  /** Relit les états persistés ; une lecture en échec garde les valeurs précédentes et le signale. */
  const readPersisted = async (): Promise<void> => {
    const seq = ++readSeq;
    const beforeFirstCycle = !concluded;
    let { join, devices, blocking } = persisted;
    let forget = persisted.forget ?? null;
    let reset = persisted.reset ?? null;
    let failed = false;
    activeReads += 1;
    try {
      const joined = await readJoinFailure(container);
      if (joined.readable) join = joined.failure;
      else failed = true;
      if (beforeFirstCycle) {
        try {
          // Cinquième revue, point 7 ; sixième revue, point 6 : trous mémorisés (texte distinct dès le démarrage), lus par src/sync ;
          // illisibles : `state-unreadable`.
          devices = await readStoredDeviceStatuses(repos);
        } catch {
          failed = true;
        }
        try {
          const raw = await repos.sync.getMeta(BLOCKING_PHASE_META);
          storedBlocking = raw;
          blocking = parseBlocking(raw);
        } catch {
          failed = true;
        }
        if (container.syncPlatform) {
          try {
            if (await container.syncPlatform.restoreMarker.get()) blocking = { phase: 'restore-choice', errorCode: null, clockAheadDevice: null };
          } catch {
            failed = true;
          }
        }
        // Y-10 : échec d'oubli et suppressions en attente gardés, montrés dès le démarrage.
        try {
          forget = await readForgetStatus(repos);
        } catch {
          failed = true;
        }
        // Y-11 : réinitialisation en cours, en échec ou appareil à associer de nouveau, montrés dès le démarrage.
        try {
          reset = await readResetStatus(repos, container.clock.nowMs());
        } catch {
          failed = true;
        }
      }
    } finally {
      activeReads -= 1;
    }
    // Un changement d'association arrivé pendant la lecture : une seule relecture, à la fin de la dernière lecture en cours.
    const again = rereadPending && activeReads === 0 && !disposed;
    if (again) rereadPending = false;
    if (!disposed && seq === readSeq) {
      persisted = { join, devices: concluded ? null : devices, blocking: concluded ? null : blocking, readFailed: failed, forget: concluded ? null : forget, reset: concluded ? null : reset };
      safely(applyBanners);
    }
    if (again) void refreshPersisted();
  };
  const refreshPersisted = (): Promise<void> => (lastRefresh = readPersisted());

  /** Garde la phase bloquante d'un cycle conclu (ou l'efface) ; écriture seulement si elle change. */
  const storeBlocking = async (status: SyncStatus): Promise<void> => {
    const fact = blockingOf(status);
    const text = fact ? JSON.stringify(fact) : null;
    if (text === storedBlocking) {
      // Rien à écrire : la base contient déjà la bonne valeur ; un échec d'écriture précédent est résolu (revue 2, point 1).
      if (writeFailed) {
        writeFailed = false;
        if (!disposed) safely(applyBanners);
      }
      return;
    }
    try {
      await repos.sync.setMeta(BLOCKING_PHASE_META, text);
      storedBlocking = text;
      writeFailed = false;
    } catch {
      writeFailed = true;
    }
    if (!disposed) safely(applyBanners);
  };

  // Y-TECH-02 (revue, point 2 ; seconde revue, point 1) : rechargement en échec journalisé (par `applyRemoteChanges`, ou ici s'il lève),
  // signalé, et son lot gardé (`failedChanges`) : relancé à la fin de chaque cycle et à « Synchroniser maintenant », jusqu'à la réussite.
  let failedChanges: RemoteChanges | null = null;
  const reload = async (change: RemoteChanges): Promise<void> => {
    let failed: boolean;
    try {
      failed = (await applyRemoteChanges(container, change)).failed.length > 0;
    } catch {
      logFailure('sync', 'remote-reload-failed {"code":"io"}');
      failed = true;
    }
    // Troisième revue, point 1 : le bandeau suit la file des lots en échec, jamais le seul dernier lot. Un lot rechargé avec succès ne
    // vide la file que s'il couvre tout ce qu'elle contient (mêmes tables, mêmes identifiants : tout y a été relu après l'échec).
    if (failed) failedChanges = mergeChanges(failedChanges, change);
    else if (failedChanges && coversChanges(change, failedChanges)) failedChanges = null;
    const stillFailed = failedChanges !== null;
    if (stillFailed === reloadFailed || disposed) return;
    reloadFailed = stillFailed;
    safely(applyBanners);
  };
  const enqueue = (run: () => Promise<void>): Promise<void> => (lastReload = lastReload.then(run));
  const retryReload = (): Promise<void> =>
    enqueue(async () => {
      const pending = failedChanges;
      if (!pending || disposed) return;
      failedChanges = null;
      await reload(pending);
    });

  const onStatus = (): void => {
    if (disposed) return;
    let reread = false;
    safely(() => {
      const current = sync.status();
      const conclusion = current.phase !== 'syncing' && current.progress === null;
      reread = conclusion || current.phase !== lastPhase;
      lastPhase = current.phase;
      if (conclusion) {
        settled = current;
        if (!concluded) {
          concluded = true;
          persisted = { ...persisted, devices: null, blocking: null, forget: null, reset: null };
        }
        lastWrite = storeBlocking(current);
        // Seconde revue, point 1 : fin de cycle, rechargements en échec retentés.
        // Troisième revue, point M3 (limite connue) : la relance ne prend que la file présente à cet instant. Un rechargement encore en
        // file (`enqueue`) qui échoue juste après n'est retenté qu'à la fin du cycle suivant (ou à « Synchroniser maintenant ») ; le
        // bandeau `reload-failed` reste visible entre-temps, aucun lot n'est perdu (`failedChanges` le garde).
        if (failedChanges) void retryReload();
      }
      applyBanners();
    });
    // Revue A-09, point 4 : jamais à chaque progression.
    if (reread) void refreshPersisted();
  };

  const stopStatus = sync.subscribe(onStatus);
  // Un changement d'association relit ; pendant une lecture, il est noté et relu une seule fois à sa fin (jamais perdu, jamais en boucle :
  // le signal de la base que la lecture provoque elle-même ne change qu'une fois par changement d'état de la base).
  const stopPairing = onPairingChange(container, () => {
    if (activeReads > 0) rereadPending = true;
    else void refreshPersisted();
  });
  setReloadRetry(container, retryReload);
  const stopChanges = sync.onRemoteChanges((change) => void enqueue(() => reload(change)));
  safely(() => {
    const initial = sync.status();
    lastPhase = initial.phase;
    settled = initial.phase === 'syncing' ? null : initial;
    applyBanners();
  });
  void refreshPersisted();
  // ADR 0011 §22 point 6 : sur iPhone, le cycle du passage en arrière-plan est borné à 25 s (tâche d'arrière-plan iOS).
  // Rappels Apple (K-05, ADR 0008 §10.8) : le passage de masquage termine (8 s au plus) AVANT le cycle, qui publie ainsi ce qu'il vient de changer.
  const hide = container.platform.os === 'ios' ? { hideDeadlineMs: HIDE_SYNC_DEADLINE_MS, ...(container.reminders.available ? { beforeHide: () => remindersHidePass(container) } : {}) } : {};
  // P-04-iOS critère 12 : marqueur de restauration non écrit (mémo) : aucun cycle ; la lecture du contexte de restauration réessaie
  // l'écriture côté Rust (iPhone) ; marqueur présent -> mémo effacé, fenêtre de choix habituelle ; sinon bandeau persistant.
  const memo = peekMarkerFailedCode();
  if (memo !== null) markerFailures.set(container, { code: memo, refresh: () => safely(applyBanners) });
  const scheduler = startSyncScheduler(sync, { document: env.document ?? document, clock: env.clock ?? container.clock, ...(env.setInterval ? { setInterval: env.setInterval } : {}), ...(env.clearInterval ? { clearInterval: env.clearInterval } : {}), ...hide, ...(memo !== null ? { startPaused: true } : {}) });
  schedulers.set(container, scheduler);
  if (memo !== null) {
    safely(applyBanners);
    void sync.restoreContext().then(
      (context) => {
        if (disposed || !context) return;
        clearMarkerFailedMemo();
        markerFailures.delete(container);
        safely(applyBanners);
        scheduler.resume();
      },
      (error: unknown) => logFailure('sync', `restore-marker-retry-failed ${JSON.stringify({ name: error instanceof Error ? error.name : typeof error })}`),
    );
  }
  return {
    reloaded: () => lastReload,
    refreshed: async () => {
      // Une relecture peut en lancer une autre (changement d'état) : attendre la dernière.
      let seen: readonly Promise<void>[] = [];
      while (seen[0] !== lastRefresh || seen[1] !== lastWrite) {
        seen = [lastRefresh, lastWrite];
        await Promise.all(seen);
      }
    },
    dispose: () => {
      disposed = true;
      markerFailures.delete(container);
      if (schedulers.get(container) === scheduler) schedulers.delete(container);
      scheduler.dispose();
      stopStatus();
      stopPairing();
      stopChanges();
      clearReloadRetry(container, retryReload);
      stopSyncingTimer();
      for (const kind of SYNC_KINDS) useAppStatusStore.getState().setStatus(kind, null);
    },
  };
}

/**
 * « Quitter » (Y-02 critère 1) : dernier cycle par le planificateur (`beforeQuit`, qui annule son minuteur dès que le cycle finit),
 * 4,5 s au plus (Rust sort à 5 s). Sans synchro branchée : rien. Ne rejette jamais.
 */
export function syncBeforeQuit(container: AppContainer): Promise<void> {
  return schedulers.get(container)?.beforeQuit(QUIT_HANDLER_SYNC_MS) ?? Promise.resolve();
}
