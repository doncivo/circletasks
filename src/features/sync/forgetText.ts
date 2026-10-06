import type { ForgetFacts } from '../../domain/syncBanners';
import type { DeviceId } from '../../domain/types';
import { t } from '../../i18n';
import type { SyncDeviceStatus } from '../../platform/sync/types';
import { deviceName } from './syncText';

/**
 * Textes de Y-10 communs à l'emplacement `forget` de Réglages, à la ligne APPAREILS et au bandeau A-09 (D5 : une seule formulation par
 * état). Jamais de code brut, de chemin ni de contenu.
 */

/** Raison lisible d'un code de refus ou d'erreur. */
export function forgetReason(code: string): string {
  switch (code) {
    case 'not-foreground':
      return t('sync.forget.reasons.notForeground');
    case 'rate-limited':
      return t('sync.forget.reasons.rateLimited');
    case 'cloud-pending':
    case 'cloud-error':
    case 'cloud-provider-stopped':
      return t('sync.forget.reasons.cloudPending');
    case 'folder-unreachable':
    case 'not-local':
    case 'unsafe-folder':
      return t('sync.forget.reasons.folderUnreachable');
    case 'vault-unavailable':
      return t('sync.forget.reasons.vaultUnavailable');
    case 'key-missing':
    case 'not-bound':
      return t('sync.forget.reasons.keyMissing');
    case 'state-mismatch':
      return t('sync.forget.reasons.stateMismatch');
    case 'not-configured':
      return t('sync.forget.reasons.notConfigured');
    default:
      return t('sync.forget.reasons.other');
  }
}

/** Nom d'un appareil comme dans APPAREILS (« PC », « iPhone », suivis de 4 caractères si deux ont la même plateforme). */
export function forgetDeviceName(id: DeviceId, devices: readonly SyncDeviceStatus[]): string {
  const device = devices.find((d) => d.deviceId === id);
  return device ? deviceName(device, devices) : t('sync.status.deviceNamed', { platform: t('sync.status.devicePc'), short: String(id).slice(0, 4) });
}

/** Échec d'un oubli, d'une suppression ou d'une association (emplacement `forget` et bandeau). */
export function forgetFailureText(failure: NonNullable<ForgetFacts['failure']>, devices: readonly SyncDeviceStatus[]): string {
  const reason = forgetReason(failure.code);
  if (failure.step === 'rejoin') return t('sync.forget.failedRejoin', { reason });
  const device = forgetDeviceName(failure.deviceId, devices);
  return failure.step === 'declare' ? t('sync.forget.failedDeclare', { device, reason }) : t('sync.forget.failedDelete', { device, reason });
}

/** Ligne APPAREILS d'un appareil oublié dont les fichiers restent ; null : rien à dire. */
export function forgetDeletionLine(deletion: ForgetFacts['deletions'][number] | undefined, devices: readonly SyncDeviceStatus[]): string | null {
  if (!deletion || deletion.state === 'done') return null;
  if (deletion.state === 'deleting') return t('sync.forget.deletionRunning');
  if (deletion.state === 'strays') return t('sync.forget.deletionStrays');
  return deletion.waitingFor ? t('sync.forget.deletionWaiting', { device: forgetDeviceName(deletion.waitingFor, devices) }) : t('sync.forget.deletionWaitingUnknown');
}

/** Bandeau de la suppression en attente : même état que la ligne APPAREILS, l'appareil oublié nommé. */
export function forgetPendingBanner(deletion: ForgetFacts['deletions'][number], devices: readonly SyncDeviceStatus[]): string {
  const device = forgetDeviceName(deletion.deviceId, devices);
  if (deletion.state === 'deleting') return t('sync.forget.bannerRunning', { device });
  if (deletion.state === 'strays') return t('sync.forget.bannerStrays', { device });
  return deletion.waitingFor ? t('sync.forget.bannerPending', { device, waiting: forgetDeviceName(deletion.waitingFor, devices) }) : t('sync.forget.bannerPendingUnknown', { device });
}
