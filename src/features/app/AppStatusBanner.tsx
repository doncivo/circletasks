import { pickAppStatus, type ActiveStatuses } from '../../domain/appStatus';
import { t } from '../../i18n';
import { StatusBanner } from '../../ui';
import { useAppStatusStore } from './appStatus';

/**
 * Bandeau d'état de l'app (A-09), monté en haut de la zone principale (App.tsx) : un seul bandeau, selon la priorité du domaine.
 * Toujours `role="status"` (`StatusBanner`), jamais `role="alert"` ni boîte bloquante, même pour un échec de synchro (critère 9 h).
 */
export function AppStatusBanner() {
  // Deux sélecteurs à valeur stable : l'état prioritaire (priorité du domaine), puis sa source.
  const kind = useAppStatusStore((state) => pickAppStatus(state.sources as ActiveStatuses));
  const source = useAppStatusStore((state) => (kind ? state.sources[kind] : undefined));
  if (!kind || !source) return null;
  switch (kind) {
    case 'calendarDisconnected':
      return (
        <StatusBanner
          message={t('status.calendarDisconnected', { name: source.detail ?? '' })}
          {...(source.onAction ? { actionLabel: t('status.reconnect'), onAction: source.onAction } : {})}
        />
      );
    case 'syncTrouble': {
      // Critères 9 c et 9 g : texte de la ligne de Réglages (composé par la synchro), « (+N) » s'il y a d'autres états, « Voir ».
      const text = source.message ?? t('sync.status.errorGeneric');
      const message = source.more && source.more > 0 ? t('status.syncTroubleMore', { message: text, n: source.more }) : text;
      return <StatusBanner message={message} {...(source.onAction ? { actionLabel: t('status.syncTroubleView'), actionAriaLabel: t('status.syncTroubleViewLabel'), onAction: source.onAction } : {})} />;
    }
    case 'updateRequired':
      // Y-07 critère 9 : texte seul, aucun bouton (mise à jour par l'updater PC ou SideStore). Détail « reintegration » : échec de
      // réintégration (exigence d'Ali), état A-09 le plus proche, faute d'autre signe visible depuis l'écran principal.
      return <StatusBanner message={t(source.detail === 'reintegration' ? 'sync.version.failedBanner' : 'sync.version.banner')} />;
    case 'waitingIcloud':
      // Critère 9 e : la cause (texte de la ligne de Réglages) quand elle est connue, sinon le texte générique.
      return <StatusBanner message={source.message ?? t('status.waitingIcloud')} />;
    case 'syncing':
      return <StatusBanner message={t('status.syncing')} />;
    case 'offline':
      return <StatusBanner message={t('status.offline')} />;
  }
}
