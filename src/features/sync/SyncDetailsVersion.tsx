import { newerDevices } from '../../domain/sync/compat';
import { t } from '../../i18n';
import { useFeatureStore } from '../app/AppContainerContext';
import { syncStore } from './syncStore';
import { newerDeviceText } from './syncText';

/**
 * Emplacement « version » de Réglages › Synchronisation › Détails (Y-07 critère 10 ; ADR 0011 §10.4) : sans maquette, composé avec les
 * lignes de Réglages. Une ligne par autre appareil actif de version plus récente (« iPhone utilise une version plus récente de l'app
 * (1.4.0) », numéro d'application publié s'il est connu, D2) et, pour une majeure supérieure, « Lecture de ses données suspendue ».
 * Jamais de numéro de migration. Absent quand tous les appareils ont la même version (ou une plus ancienne). Annoncé (`role="status"`).
 */
export function SyncDetailsVersion() {
  const devices = useFeatureStore(syncStore, (s) => s.status.devices);
  const newer = newerDevices(devices);
  if (newer.length === 0) return null;
  return (
    <>
      <h2 className="ct-settings__section">{t('sync.version.section')}</h2>
      <div role="status" className="ct-sync__version">
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
