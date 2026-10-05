import { Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../../i18n';
import { Icon } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useNavigationStore } from '../app/navigation';
import { SyncStatusLine } from './SyncStatusLine';
import { syncStore } from './syncStore';
import { deviceName, deviceStatusText, formatSyncTime } from './syncText';
import './SyncDetailsScreen.css';

export interface SyncDetailsSlots {
  /** Y-06 : bouton « Associer ». */
  readonly pairing?: ReactNode;
  /** Y-04 : journal des conflits. */
  readonly conflicts?: ReactNode;
  /** Y-07 : version et lecture suspendue. */
  readonly version?: ReactNode;
}

/**
 * Réglages › Synchronisation, détails (Y-02 critère 17, Y-03 critère 1, Y-09 critère 10) : sans maquette PC, composé avec les lignes
 * de Réglages d'après Synchro.html (iPhone) : état et « Synchroniser », APPAREILS (dernière lecture et statut), fichiers en attente
 * d'iCloud, nombre de conflits de la semaine. Emplacements vides pour l'appairage (Y-06), les conflits (Y-04) et la version (Y-07).
 */
export function SyncDetailsScreen({ slots = {} }: { readonly slots?: SyncDetailsSlots }) {
  const container = useAppContainer();
  const navigate = useNavigationStore((s) => s.navigate);
  const status = useFeatureStore(syncStore, (s) => s.status);
  const nowMs = container.clock.nowMs();
  return (
    <div className="ct-settings ct-sync">
      <div className="ct-sync__topRow">
        <button type="button" className="ct-sync__back" aria-label={t('sync.status.back')} onClick={() => navigate({ tab: 'settings', screen: 'home' })}>
          <Icon icon={Undo2} size={26} />
        </button>
      </div>
      <h1 className="ct-settings__title">{t('sync.status.title')}</h1>
      <h2 className="ct-settings__section">{t('sync.status.sectionState')}</h2>
      <div className="ct-settings__row ct-sync__stateRow">
        <SyncStatusLine showDetailsLink={false} />
      </div>
      {status.progress && (
        <p className="ct-sync__progress" role="status">
          {t('sync.status.progress', { done: status.progress.done, total: status.progress.total })}
        </p>
      )}
      {slots.pairing}
      {slots.version}
      <h2 className="ct-settings__section">{t('sync.status.sectionDevices')}</h2>
      <ul className="ct-sync__devices">
        {status.devices.map((device) => (
          <li key={device.deviceId} className="ct-settings__row ct-sync__device" data-status={device.status}>
            <span className="ct-sync__deviceName">
              {device.self
                ? device.lastReadAt
                  ? t('sync.status.thisDevice', { time: formatSyncTime(device.lastReadAt, nowMs) })
                  : t('sync.status.thisDeviceNever')
                : deviceName(device, status.devices)}
            </span>
            {!device.self && (
              <span className="ct-sync__deviceRead">{device.lastReadAt ? t('sync.status.lastRead', { time: formatSyncTime(device.lastReadAt, nowMs) }) : t('sync.status.neverRead')}</span>
            )}
            {!device.self && <span className="ct-settings__value ct-sync__deviceState">{deviceStatusText(device.status)}</span>}
          </li>
        ))}
      </ul>
      {status.pendingFiles.length > 0 && (
        <>
          <h2 className="ct-settings__section">{t('sync.status.sectionPending')}</h2>
          <div className="ct-settings__row">
            <span>{status.pendingFiles.length === 1 ? t('sync.status.pendingOne', { count: 1 }) : t('sync.status.pendingMany', { count: status.pendingFiles.length })}</span>
          </div>
        </>
      )}
      <h2 className="ct-settings__section">{t('sync.status.sectionConflicts')}</h2>
      <div className="ct-settings__row">
        <span>
          {status.conflictsThisWeek === 0
            ? t('sync.status.noConflicts')
            : status.conflictsThisWeek === 1
              ? t('sync.status.conflictsOne', { count: 1 })
              : t('sync.status.conflictsMany', { count: status.conflictsThisWeek })}
        </span>
      </div>
      {slots.conflicts}
    </div>
  );
}
