import type { SyncWarningCode } from '../../domain/syncBanners';
import { syncErrorFamily } from '../../domain/sync/errorFamily';
import { isSyncErrorCode } from '../../domain/sync/format';
import { WAITING_ICLOUD_LONG_MS } from '../../domain/sync/limits';
import type { DeviceId } from '../../domain/types';
import { getLocale, t } from '../../i18n';
import { formatStamp, formatTime } from '../../i18n/format';
import { detectOs } from '../../platform/runtime';
import type { SyncDeviceStatus, SyncFolderInfo, SyncStatus } from '../../platform/sync/types';
import { syncAge } from '../../sync';

/**
 * Textes de l'état de synchro (Y-02 critère 16, Y-05 critère 2, Y-09 critère 10, Y-07 critères 8 et 10) : sous-ligne de Réglages (« À jour · il y a 2 min »,
 * D2), messages d'erreur explicites, noms d'appareils (« PC », « iPhone », suivis de 4 caractères si deux ont la même plateforme).
 */

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Heure d'un instant : « 15:28 » le jour même (24 h ou format P-03), sinon « hier à 15:28 », « le 2 oct. à 15:28 ». */
export function formatSyncTime(iso: string, nowMs: number): string {
  const then = new Date(iso);
  const now = new Date(nowMs);
  if (then.toDateString() === now.toDateString()) return formatTime(`${pad2(then.getHours())}:${pad2(then.getMinutes())}`);
  return formatStamp(iso, nowMs);
}

/** Âge de la dernière synchro (D2), même découpage que « Mis à jour il y a … » des agendas. */
export function formatSyncAge(lastSyncAt: string, nowMs: number): string {
  const age = syncAge(lastSyncAt as SyncStatus['lastSyncAt'] & string, nowMs);
  switch (age.unit) {
    case 'now':
      return t('sync.status.ageNow');
    case 'min':
      return t('sync.status.ageMinutes', { n: age.n });
    case 'h':
      return t('sync.status.ageHours', { n: age.n });
    case 'd':
      return t('sync.status.ageDays', { n: age.n });
  }
}

/** Nom affiché d'un appareil. */
export function deviceName(device: Pick<SyncDeviceStatus, 'deviceId' | 'platform' | 'seen'>, all: readonly Pick<SyncDeviceStatus, 'platform' | 'seen'>[]): string {
  // Y-10 (audit a) : appareil jamais lu, nom neutre et 8 caractères, jamais une plateforme inventée.
  if (device.seen === false) return t('sync.forget.unseenName', { short: String(device.deviceId).slice(0, 8) });
  const platform = t(device.platform === 'ios' ? 'sync.status.deviceIphone' : 'sync.status.devicePc');
  const twins = all.filter((d) => d.platform === device.platform && d.seen !== false).length > 1;
  return twins ? t('sync.status.deviceNamed', { platform, short: String(device.deviceId).slice(0, 4) }) : platform;
}

/**
 * Plateforme de cet appareil : sa ligne d'APPAREILS (`self`), sinon le système détecté (avant le premier cycle conclu). Choisit les textes
 * propres à l'iPhone (ADR 0011 §22 point 8, §23 point 1).
 */
export function ownPlatform(status: Pick<SyncStatus, 'devices'>): 'windows' | 'ios' {
  const own = status.devices.find((d) => d.self)?.platform;
  if (own === 'ios' || own === 'windows') return own;
  return detectOs() === 'ios' ? 'ios' : 'windows';
}

function errorText(code: string | null | undefined, platform: 'windows' | 'ios' = 'windows'): string {
  switch (code) {
    case 'folder-unreachable':
      // iPhone : signet perdu ou dossier déplacé : le dossier est à choisir de nouveau (bouton « Choisir le dossier » de Réglages).
      return platform === 'ios' ? t('sync.status.errorFolderUnreachableIos') : t('sync.status.errorFolderUnreachable');
    case 'not-local':
      return t('sync.status.errorFolderUnreachable');
    case 'cloud-provider-stopped':
      return t('sync.status.errorCloudProviderStopped');
    case 'cloud-error':
    case 'cloud-pending':
      return t('sync.status.errorCloud');
    case 'unsafe-folder':
      return t('sync.status.errorUnsafeFolder');
    case 'folder-too-large':
      return t('sync.status.errorFolderTooLarge');
    case 'vault-unavailable':
      // iPhone (§23 point 1) : Trousseau illisible tant que l'iPhone est verrouillé.
      return platform === 'ios' ? t('sync.status.errorVaultIos') : t('sync.status.errorVault');
    case 'rollback':
      return t('sync.status.errorRollback');
    default:
      return stoppedText(code);
  }
}

/**
 * Y-IOS-02 (audit des impasses) : « nouvel essai au prochain cycle » seulement pour une erreur passagère ; une erreur permanente dit son
 * action et son code (le planificateur ne la relance plus en boucle).
 */
function stoppedText(code: string | null | undefined): string {
  if (!isSyncErrorCode(code)) return code ? t('sync.status.errorStopped', { code }) : t('sync.status.errorGeneric');
  switch (syncErrorFamily(code)) {
    case 'transient':
      return t('sync.status.errorGeneric');
    case 'pairing':
      return t('sync.status.errorStoppedPairing', { code });
    case 'folder':
      return t('sync.status.errorStoppedFolder', { code });
    case 'reset':
      return t('sync.status.errorStoppedReset', { code });
    case 'update':
      return t('sync.status.errorStoppedUpdate', { code });
    case 'details':
      return t('sync.status.errorStopped', { code });
  }
}

/**
 * Phases où un échec de réintégration remplace le texte (les erreurs, clés, versions et horloges gardent le leur, plus urgent) ; synchro
 * non configurée comprise (revue 2) : l'échec vient du démarrage, pas de la synchro, il reste à signaler.
 */
const FAILURE_SHOWN_IN: ReadonlySet<SyncStatus['phase']> = new Set(['idle', 'waiting-icloud', 'not-configured']);

/** L'échec de réintégration (exigence d'Ali) est-il le texte de la ligne de Réglages ? */
function failureShown(status: SyncStatus): boolean {
  return Boolean(status.reintegrationFailure) && FAILURE_SHOWN_IN.has(status.phase);
}

/** « 3 éléments reçus d'une version plus récente n'ont pas pu être intégrés » (exigence d'Ali, Y-07). */
export function failureLine(fields: number): string {
  return fields === 1 ? t('sync.version.failedLineOne') : t('sync.version.failedLineMany', { count: fields });
}

const KIND_KEYS = {
  space: 'sync.version.kinds.space',
  project: 'sync.version.kinds.project',
  recurrence: 'sync.version.kinds.recurrence',
  goal: 'sync.version.kinds.goal',
  task: 'sync.version.kinds.task',
  routine: 'sync.version.kinds.routine',
  routine_log: 'sync.version.kinds.routineLog',
  routine_pause: 'sync.version.kinds.routinePause',
  reminder: 'sync.version.kinds.reminder',
  event: 'sync.version.kinds.event',
  checklist: 'sync.version.kinds.checklist',
  checklist_item: 'sync.version.kinds.checklistItem',
  focus_session: 'sync.version.kinds.focusSession',
  calendar_account: 'sync.version.kinds.calendarAccount',
  holiday: 'sync.version.kinds.holiday',
  settings: 'sync.version.kinds.settings',
} as const;

/** Types d'éléments d'un échec (« tâches, événements »), d'après les tables du catalogue. */
export function failureKinds(tables: readonly string[]): string {
  const labels = tables.map((table) => (Object.prototype.hasOwnProperty.call(KIND_KEYS, table) ? t(KIND_KEYS[table as keyof typeof KIND_KEYS]) : t('sync.version.kinds.other')));
  return [...new Set(labels)].join(', ');
}

/** Attente d'iCloud prolongée (audit, point bas 8) : plus de `WAITING_ICLOUD_LONG_MS` depuis la dernière synchro complète. */
export function waitingLong(status: Pick<SyncStatus, 'phase' | 'lastSyncAt' | 'waitingSince'>, nowMs: number): boolean {
  // Référence : dernière synchro complète, sinon (jamais synchronisé) début de l'attente (seconde revue, point 6).
  const since = status.lastSyncAt ?? status.waitingSince ?? null;
  return status.phase === 'waiting-icloud' && since !== null && nowMs - Date.parse(since) >= WAITING_ICLOUD_LONG_MS;
}

/**
 * Seconde revue, point 2 : texte d'attente prolongée selon la plateforme de cet appareil (ligne `self` d'APPAREILS) : PC, iCloud pour
 * Windows ; iPhone, iCloud Drive dans Réglages ; inconnue, texte neutre.
 */
function waitingLongText(status: SyncStatus): string {
  switch (status.devices.find((d) => d.self)?.platform) {
    case 'windows':
      return t('sync.status.waitingIcloudLongWindows');
    case 'ios':
      return t('sync.status.waitingIcloudLongIos');
    default:
      return t('sync.status.waitingIcloudLong');
  }
}

/** Sous-ligne de la ligne « iCloud Drive / CircleTasks » de Réglages. */
export function statusLine(status: SyncStatus, nowMs: number): string {
  if (failureShown(status) && status.reintegrationFailure) return failureLine(status.reintegrationFailure.fields);
  switch (status.phase) {
    case 'not-configured':
      return t('sync.status.notConfigured');
    case 'needs-pairing':
      // Y-IOS-02 : sur l'iPhone, l'association se fait avec le PC (« Associer au PC »).
      return ownPlatform(status) === 'ios' ? t('sync.status.needsPairingIos') : t('sync.status.needsPairing');
    case 'syncing':
      return t('sync.status.syncingPhase');
    case 'waiting-icloud':
      // Audit (point bas 8) : une attente qui dure n'est pas un simple délai (référence : dernière synchro complète).
      if (waitingLong(status, nowMs)) return waitingLongText(status);
      return status.errorCode ? errorText(status.errorCode, ownPlatform(status)) : t('sync.status.waitingIcloud');
    case 'restore-choice':
      return t('sync.status.restoreChoice');
    case 'update-required': {
      // Y-07 critère 8 : l'appareil dont la lecture est suspendue, nommé comme dans APPAREILS.
      const device = status.devices.find((d) => !d.self && d.status === 'newer-major');
      return device ? t('sync.status.updateRequiredDevice', { device: deviceName(device, status.devices) }) : t('sync.status.updateRequired');
    }
    case 'clock-ahead': {
      const device = status.devices.find((d) => d.deviceId === (status.clockAheadDevice as DeviceId | null));
      return t('sync.status.clockAhead', { device: device ? deviceName(device, status.devices) : '' });
    }
    case 'key-mismatch':
      return t('sync.status.keyMismatch');
    case 'error':
      // Revue de la PR #14 : erreur passagère répétée : cycles espacés, jamais arrêtés ; l'heure du prochain essai est dite.
      if (status.retryAt && status.errorCode) return t('sync.status.errorSlowed', { time: formatSyncTime(status.retryAt, nowMs), code: status.errorCode });
      return errorText(status.errorCode, ownPlatform(status));
    case 'forgotten':
      return t('sync.forget.banner');
    case 'reset-required':
      return resetRequiredLine(status.reset, status.devices);
    case 'idle':
      return status.lastSyncAt ? t('sync.status.upToDate', { age: formatSyncAge(status.lastSyncAt, nowMs) }) : t('sync.status.neverSynced');
  }
}

/**
 * Y-11 : appareil à associer de nouveau (annonce authentique d'un autre appareil) ou perdant d'une réinitialisation simultanée (§18
 * point 2), l'appareil gagnant nommé comme dans APPAREILS.
 */
export function resetRequiredLine(reset: Pick<NonNullable<SyncStatus['reset']>, 'by' | 'superseded' | 'restore' | 'closed'> | null | undefined, devices: readonly SyncDeviceStatus[]): string {
  if (!reset?.superseded) return t('sync.reset.required');
  if (!reset.by || reset.closed) return t('sync.reset.supersededUnknown');
  const device = devices.find((d) => d.deviceId === reset.by);
  const name = device ? deviceName(device, devices) : t('sync.forget.unseenName', { short: String(reset.by).slice(0, 8) });
  // §18 point 16 : perdue face à une restauration appliquée partout : rien à associer, à relancer.
  return reset.restore ? t('sync.reset.supersededRestore', { device: name }) : t('sync.reset.superseded', { device: name });
}

/** Y-TECH-02 : texte d'un avertissement du scan (bandeau et section AVERTISSEMENTS des détails, une seule formulation). */
export function warningText(code: SyncWarningCode): string {
  switch (code) {
    case 'nonce-budget':
      return t('sync.status.warnNonceBudget');
    case 'folder-large':
      return t('sync.status.warnFolderLarge');
    case 'too-many-devices':
      return t('sync.status.warnTooManyDevices');
    case 'scan-incomplete':
      return t('sync.status.warnScanIncomplete');
  }
}

/**
 * Libellé du statut d'un appareil (APPAREILS, bandeau d'appareil). Cinquième revue, point 7 : `corrupt` posé par un trou impossible à
 * combler (`gapSince`) a son propre texte, jamais « Fichiers illisibles ».
 */
export function deviceStatusText(device: Pick<SyncDeviceStatus, 'status' | 'gapSince'>): string {
  const { status } = device;
  if (status === 'corrupt' && device.gapSince !== undefined) return t('sync.status.stateGap');
  switch (status) {
    case 'active':
      return t('sync.status.stateActive');
    case 'expired':
      return t('sync.status.stateExpired');
    case 'newer-major':
      return t('sync.status.stateNewerMajor');
    case 'clock-ahead':
      return t('sync.status.stateClockAhead');
    case 'corrupt':
      return t('sync.status.stateCorrupt');
    case 'foreign':
      return t('sync.status.stateForeign');
    case 'rollback':
      return t('sync.status.stateRollback');
    case 'forgotten':
      return t('sync.status.stateForgotten');
  }
}

/** Le texte de la phase est-il une erreur (couleur d'alerte, `role="alert"` évité : jamais de boîte bloquante) ? */
export function isTroublePhase(status: SyncStatus): boolean {
  return (
    status.phase === 'error' ||
    status.phase === 'key-mismatch' ||
    status.phase === 'clock-ahead' ||
    status.phase === 'update-required' ||
    status.phase === 'forgotten' ||
    status.phase === 'reset-required' ||
    failureShown(status)
  );
}

/**
 * Ligne de l'emplacement « version » (Y-07 critère 10, D2) : « {appareil} utilise une version plus récente de l'app », avec le numéro
 * d'application publié s'il est connu ; jamais un numéro de migration.
 */
export function newerDeviceText(device: Pick<SyncDeviceStatus, 'deviceId' | 'platform' | 'appVersion'>, all: readonly Pick<SyncDeviceStatus, 'platform'>[]): string {
  const name = deviceName(device, all);
  return device.appVersion ? t('sync.version.newerWithVersion', { device: name, version: device.appVersion }) : t('sync.version.newer', { device: name });
}

/** Libellé affiché d'un dossier (jamais un chemin) : « iCloud Drive / <nom> » pour un dossier iCloud, sinon son nom (revue 13). */
export function folderLabel(info: Pick<SyncFolderInfo, 'label' | 'kind'> | null): string {
  if (!info?.label) return t('sync.folder.rowLabel');
  return info.kind === 'icloud' ? t('sync.folder.icloudLabel', { name: info.label }) : info.label;
}

/** Nombre groupé selon la langue courante (« 1 200 » en français, « 1,200 » en anglais). */
export function formatCount(value: number): string {
  return new Intl.NumberFormat(getLocale() === 'fr' ? 'fr-FR' : 'en-US').format(value);
}
