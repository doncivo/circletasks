import { useState } from 'react';
import { isSyncErrorCode } from '../../domain/sync/format';
import { tOwnDeletion } from '../../i18n/syncOwnDeletionText';
import { Button } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { syncStore } from './syncStore';
import { errorText, ownPlatform } from './syncText';
import './SyncDetailsOwnDeletion.css';

export function SyncDetailsOwnDeletion() {
  const container = useAppContainer();
  const status = useFeatureStore(syncStore, (s) => s.status);
  const storeBusy = useFeatureStore(syncStore, (s) => s.busy);
  const [retrying, setRetrying] = useState(false);
  const failures = [...new Map((status.ownDelete ?? []).map((f) => [`${f.epoch}/${String(f.orphan)}/${f.code}`, f])).values()];
  const busy = retrying || storeBusy || status.phase === 'syncing';
  if (failures.length === 0) return null;
  return (
    <div className="ct-sync__ownDeletion" role="status">
      {failures.map((f) => (
        <div key={`${f.epoch}/${String(f.orphan)}/${f.code}`}>
          <p>{tOwnDeletion(f.orphan ? 'orphan' : 'own', { cause: errorText(isSyncErrorCode(f.code) ? f.code : null, ownPlatform(status)) })}</p>
          <p>{tOwnDeletion('lastTry', { time: new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(f.at)) })}</p>
          <p>{tOwnDeletion('folder', { device: String(container.hlc.deviceId).slice(0, 8), epoch: f.epoch })}</p>
        </div>
      ))}
      <Button variant="secondary" disabled={busy} ariaBusy={busy} onClick={() => {
        setRetrying(true);
        void syncStore.get(container).getState().syncNow('manual').finally(() => setRetrying(false));
      }}>{tOwnDeletion('retry')}</Button>
    </div>
  );
}
