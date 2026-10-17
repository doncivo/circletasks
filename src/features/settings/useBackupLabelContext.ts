import { useEffect, useState } from 'react';
import { logDesktopFailure } from '../../platform';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { syncStore } from '../sync/syncStore';
import { EMPTY_BACKUP_CONTEXT, type BackupLabelContext } from './backupLabels';

/** `sync_meta.epoch` est un texte JSON (`"e0001-…"`) ; toute autre forme vaut « inconnue ». */
export function decodeStoredEpoch(raw: string | null): string | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Y-TECH-04 (partie C) : contexte des libellés de la feuille de restauration. Appareils connus et oubliés : état de synchro (`syncStore`) ;
 * identité propre : sa ligne d'APPAREILS, sinon le réglage local `device.id` ; époque courante : `sync_meta.epoch` par le dépôt de synchro.
 * Une lecture en échec est consignée et vaut « inconnue » (jamais de fausse mention « autre époque »).
 */
export function useBackupLabelContext(): BackupLabelContext {
  const container = useAppContainer();
  const devices = useFeatureStore(syncStore, (s) => s.status.devices);
  const [stored, setStored] = useState<{ readonly ownId: string | null; readonly currentEpoch: string | null }>({ ownId: null, currentEpoch: null });

  useEffect(() => {
    let cancelled = false;
    const repos = (container.data as { readonly repos?: typeof container.data.repos }).repos;
    if (!repos) return undefined;
    void (async () => {
      let ownId: string | null = null;
      let currentEpoch: string | null = null;
      try {
        ownId = await repos.settings.get('device.id');
      } catch (error) {
        logDesktopFailure('backup-label-device', error);
      }
      try {
        currentEpoch = decodeStoredEpoch(await repos.sync.getMeta('epoch'));
      } catch (error) {
        logDesktopFailure('backup-label-epoch', error);
      }
      if (!cancelled) setStored({ ownId, currentEpoch });
    })();
    return () => {
      cancelled = true;
    };
  }, [container]);

  const selfLine = devices.find((device) => device.self)?.deviceId ?? null;
  if (devices.length === 0 && stored.ownId === null && stored.currentEpoch === null) return EMPTY_BACKUP_CONTEXT;
  return { ownId: selfLine ?? stored.ownId, devices, currentEpoch: stored.currentEpoch };
}
