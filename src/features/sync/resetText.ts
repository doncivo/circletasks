import type { ResetFacts } from '../../domain/syncBanners';
import type { DeviceId } from '../../domain/types';
import { t } from '../../i18n';
import type { SyncDeviceStatus } from '../../platform/sync/types';
import { forgetDeviceName } from './forgetText';
import { resetRequiredLine } from './syncText';

/**
 * Textes de Y-11 communs à l'emplacement `reset` de Réglages, à la ligne de Réglages (`statusLine`) et aux bandeaux A-09 (D5 : une seule
 * formulation par état). Jamais de clé, de code brut, de chemin ni de contenu.
 */

/** Raison lisible d'un code de refus ou d'erreur. */
export function resetReason(code: string): string {
  switch (code) {
    case 'vault-unavailable':
    case 'key-missing':
      return t('sync.reset.reasons.vaultUnavailable');
    case 'cloud-pending':
    case 'cloud-error':
    case 'cloud-provider-stopped':
      return t('sync.reset.reasons.cloudPending');
    case 'folder-unreachable':
    case 'not-local':
    case 'unsafe-folder':
    case 'not-configured':
      return t('sync.reset.reasons.folderUnreachable');
    case 'key-exhausted':
      return t('sync.reset.reasons.keyExhausted');
    case 'state-mismatch':
      return t('sync.reset.reasons.stateMismatch');
    case 'not-foreground':
      return t('sync.reset.reasons.notForeground');
    case 'rate-limited':
      return t('sync.reset.reasons.rateLimited');
    case 'io':
      return t('sync.reset.reasons.io');
    default:
      return t('sync.reset.reasons.other');
  }
}

function stepName(step: string): string {
  switch (step) {
    case 'start':
      return t('sync.reset.stepNames.start');
    case 'announced':
      return t('sync.reset.stepNames.announced');
    case 'snapshot':
      return t('sync.reset.stepNames.snapshot');
    case 'waiting-devices':
      return t('sync.reset.stepNames.waitingDevices');
    case 'switching':
      return t('sync.reset.stepNames.switching');
    case 'superseded':
      return t('sync.reset.stepNames.superseded');
    case 'joined':
      return t('sync.reset.stepNames.joined');
    case 'required':
      return t('sync.reset.stepNames.required');
    default:
      return t('sync.reset.stepNames.done');
  }
}

/** Échec gardé (« La réinitialisation a échoué (étape) : raison »). */
export function resetFailureText(failure: NonNullable<ResetFacts['failure']>): string {
  const reason = resetReason(failure.code);
  return failure.step === 'start' ? t('sync.reset.failedStart', { reason }) : t('sync.reset.failed', { step: stepName(failure.step), reason });
}

/** Étape en cours, en clair (« Réinitialisation : en attente de 2 appareils »). */
export function resetStepText(reset: ResetFacts & { readonly resumed?: boolean }, devices: readonly SyncDeviceStatus[]): string {
  switch (reset.step) {
    case 'start':
      return t('sync.reset.steps.start');
    case 'announced':
      return t('sync.reset.steps.announced');
    case 'snapshot':
      return t('sync.reset.steps.snapshot');
    case 'waiting-devices':
      return reset.waiting.length === 1 ? t('sync.reset.steps.waitingOne') : t('sync.reset.steps.waitingMany', { count: reset.waiting.length });
    case 'switching':
      return t('sync.reset.steps.switching');
    case 'joined':
      return reset.by ? t('sync.reset.steps.joined', { device: forgetDeviceName(reset.by, devices) }) : t('sync.reset.steps.joinedUnknown');
    case 'done':
      return reset.resumed === true ? t('sync.reset.steps.doneResumed') : t('sync.reset.steps.done');
    default:
      return resetRequiredText(reset, devices);
  }
}

/** Appareil à associer de nouveau : annonce d'un autre appareil, ou perte de sa propre réinitialisation (§18 point 2). */
export function resetRequiredText(reset: Pick<ResetFacts, 'by' | 'superseded'> | null | undefined, devices: readonly SyncDeviceStatus[]): string {
  return resetRequiredLine(reset, devices);
}

/** Bandeau de la réinitialisation en cours : l'échec s'il y en a un, sinon l'étape. */
export function resetProgressBanner(reset: ResetFacts, devices: readonly SyncDeviceStatus[]): string {
  return reset.failure ? resetFailureText(reset.failure) : resetStepText(reset, devices);
}

/** Rappel des 30 jours : appareils pas encore associés, nommés comme dans APPAREILS. */
export function resetReminderText(waiting: readonly DeviceId[], devices: readonly SyncDeviceStatus[]): string {
  return t('sync.reset.reminder', { devices: waiting.map((id) => forgetDeviceName(id, devices)).join(', ') });
}
