import { newerDevices } from '../../domain/sync/compat';
import { t } from '../../i18n';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { syncStore } from './syncStore';
import { failureKinds, formatSyncTime, newerDeviceText } from './syncText';

/**
 * Emplacement « version » de Réglages › Synchronisation › Détails (Y-07 critère 10 ; ADR 0011 §10.4) : sans maquette, composé avec les
 * lignes de Réglages. Une ligne par autre appareil actif de version plus récente (« iPhone utilise une version plus récente de l'app
 * (1.4.0) », numéro d'application publié s'il est connu, D2) et, pour une majeure supérieure, « Lecture de ses données suspendue ».
 * Exigence d'Ali : un échec de réintégration au dernier démarrage est détaillé ici (nombre, types d'éléments, date du dernier essai,
 * « L'app réessaie à chaque démarrage »), sans valeur ni message d'erreur. Jamais de numéro de migration. Absent quand il n'y a rien à
 * dire. Annoncé (`role="status"`).
 */
export function SyncDetailsVersion() {
  const container = useAppContainer();
  const devices = useFeatureStore(syncStore, (s) => s.status.devices);
  const failure = useFeatureStore(syncStore, (s) => s.status.reintegrationFailure ?? null);
  const newer = newerDevices(devices);
  if (newer.length === 0 && !failure) return null;
  return (
    <>
      <h2 className="ct-settings__section">{t('sync.version.section')}</h2>
      <div role="status" className="ct-sync__version">
        {failure && (
          <div className="ct-settings__row ct-sync__device" data-failed="true">
            <span className="ct-sync__deviceName">
              {failure.fields === 1 ? t('sync.version.failedDetailOne', { kinds: failureKinds(failure.tables) }) : t('sync.version.failedDetail', { count: failure.fields, kinds: failureKinds(failure.tables) })}
            </span>
            <span className="ct-sync__deviceRead">{t('sync.version.failedLastTry', { time: formatSyncTime(failure.at, container.clock.nowMs()) })}</span>
            <span className="ct-sync__deviceRead">{t('sync.version.failedRetry')}</span>
          </div>
        )}
        {newer.map((device) => (
          <div key={device.deviceId} className="ct-settings__row ct-sync__device" data-newer={device.newer ?? undefined}>
            <span className="ct-sync__deviceName">{newerDeviceText(device, devices)}</span>
            {device.newer === 'major' && <span className="ct-sync__deviceRead">{t('sync.version.readSuspended')}</span>}
          </div>
        ))}
      </div>
    </>
  );
}
