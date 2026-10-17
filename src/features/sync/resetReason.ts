import { t } from '../../i18n';

/**
 * Y-11 : raison lisible d'un code de refus ou d'erreur. Utilisée par `resetText.ts` (réexportée) et par la fenêtre de choix après restauration (`RestoreChoiceDialog`,
 * bloc à la demande, Y-FIX-04) ; module à part de `resetText.ts` pour que la fenêtre n'entraîne pas les textes de la synchro du départ
 * dans son bloc (et inversement).
 */
/** Raison lisible d'un code de refus ou d'erreur. */
export function resetReason(code: string): string {
  switch (code) {
    case 'vault-unavailable':
      return t('sync.reset.reasons.vaultUnavailable');
    case 'key-missing':
      // Y-IOS-02 : réinitialisation refusée à un appareil sans clé (jamais « coffre indisponible », la clé n'existe pas).
      return t('sync.reset.reasons.keyMissing');
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
    case 'key-mismatch':
      return t('sync.reset.reasons.keyMismatch');
    case 'invalid-pairing':
      return t('sync.reset.reasons.invalidPairing');
    case 'pairing-expired':
      return t('sync.reset.reasons.pairingExpired');
    default:
      return t('sync.reset.reasons.other');
  }
}
