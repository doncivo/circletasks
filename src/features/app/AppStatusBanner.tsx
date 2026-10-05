import { pickAppStatus, type ActiveStatuses } from '../../domain/appStatus';
import { t } from '../../i18n';
import { StatusBanner } from '../../ui';
import { useAppStatusStore } from './appStatus';

/**
 * Bandeau d'état de l'app (A-09), monté en haut de la zone principale (App.tsx) : un seul bandeau, selon la priorité
 * du domaine. Textes des quatre états dans src/i18n ; à l'ordre 1 seul « Hors ligne » est émis.
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
    case 'updateRequired':
      // Y-07 critère 9 : texte seul, aucun bouton (mise à jour par l'updater PC ou SideStore). Détail « reintegration » : échec de
      // réintégration (exigence d'Ali), état A-09 le plus proche, faute d'autre signe visible depuis l'écran principal.
      return <StatusBanner message={t(source.detail === 'reintegration' ? 'sync.version.failedBanner' : 'sync.version.banner')} />;
    case 'waitingIcloud':
      return <StatusBanner message={t('status.waitingIcloud')} />;
    case 'syncing':
      return <StatusBanner message={t('status.syncing')} />;
    case 'offline':
      return <StatusBanner message={t('status.offline')} />;
  }
}
