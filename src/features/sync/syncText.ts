import type { DeviceId } from '../../domain/types';
import { t } from '../../i18n';
import { formatStamp, formatTime } from '../../i18n/format';
import type { SyncDeviceStatus, SyncFolderInfo, SyncStatus } from '../../platform/sync/types';
import { syncAge } from '../../sync';

/**
 * Textes de l'état de synchro (Y-02 critère 16, Y-05 critère 2, Y-09 critère 10) : sous-ligne de Réglages (« À jour · il y a 2 min »,
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
export function deviceName(device: Pick<SyncDeviceStatus, 'deviceId' | 'platform'>, all: readonly Pick<SyncDeviceStatus, 'platform'>[]): string {
  const platform = t(device.platform === 'ios' ? 'sync.status.deviceIphone' : 'sync.status.devicePc');
  const twins = all.filter((d) => d.platform === device.platform).length > 1;
  return twins ? t('sync.status.deviceNamed', { platform, short: String(device.deviceId).slice(0, 4) }) : platform;
}

function errorText(code: string | null | undefined): string {
  switch (code) {
    case 'folder-unreachable':
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
      return t('sync.status.errorVault');
    case 'rollback':
      return t('sync.status.errorRollback');
    default:
      return t('sync.status.errorGeneric');
  }
}

/** Sous-ligne de la ligne « iCloud Drive / CircleTasks » de Réglages. */
export function statusLine(status: SyncStatus, nowMs: number): string {
  switch (status.phase) {
    case 'not-configured':
      return t('sync.status.notConfigured');
    case 'needs-pairing':
      return t('sync.status.needsPairing');
    case 'syncing':
      return t('sync.status.syncingPhase');
    case 'waiting-icloud':
      return status.errorCode ? errorText(status.errorCode) : t('sync.status.waitingIcloud');
    case 'restore-choice':
      return t('sync.status.restoreChoice');
    case 'update-required':
      return t('sync.status.updateRequired');
    case 'clock-ahead': {
      const device = status.devices.find((d) => d.deviceId === (status.clockAheadDevice as DeviceId | null));
      return t('sync.status.clockAhead', { device: device ? deviceName(device, status.devices) : '' });
    }
    case 'key-mismatch':
      return t('sync.status.keyMismatch');
    case 'error':
      return errorText(status.errorCode);
    case 'idle':
      return status.lastSyncAt ? t('sync.status.upToDate', { age: formatSyncAge(status.lastSyncAt, nowMs) }) : t('sync.status.neverSynced');
  }
}

/** Libellé du statut d'un appareil (APPAREILS). */
export function deviceStatusText(status: SyncDeviceStatus['status']): string {
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
  return status.phase === 'error' || status.phase === 'key-mismatch' || status.phase === 'clock-ahead' || status.phase === 'update-required';
}

/** Libellé affiché d'un dossier (jamais un chemin) : « iCloud Drive / <nom> » pour un dossier iCloud, sinon son nom (revue 13). */
export function folderLabel(info: Pick<SyncFolderInfo, 'label' | 'kind'> | null): string {
  if (!info?.label) return t('sync.folder.rowLabel');
  return info.kind === 'icloud' ? t('sync.folder.icloudLabel', { name: info.label }) : info.label;
}

