import { useState } from 'react';
import { t } from '../../i18n';
import type { SyncDeviceStatus } from '../../platform/sync/types';
import { useFeatureStore } from '../app/AppContainerContext';
import { syncStore } from './syncStore';
import { deviceName } from './syncText';

/** Surnom local seulement. L'identifiant reste visible pour distinguer deux noms identiques. */
export function SyncDeviceName({ device, devices }: { readonly device: SyncDeviceStatus; readonly devices: readonly SyncDeviceStatus[] }) {
  const rename = useFeatureStore(syncStore, (s) => s.renameDevice);
  const ready = useFeatureStore(syncStore, (s) => s.deviceNamesLoaded);
  const busy = useFeatureStore(syncStore, (s) => s.deviceNameBusy);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const name = deviceName(device, devices);
  return (
    <>
      {editing ? (
        <form className="ct-sync__nameForm" onSubmit={(event) => { event.preventDefault(); void rename(device.deviceId, draft).then((ok) => { if (ok) setEditing(false); }); }}>
          <label>{t('sync.status.nameLabel')}<input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={80} disabled={busy} autoFocus /></label>
          <button type="submit" disabled={busy}>{t('sync.status.nameSave')}</button>
          <button type="button" disabled={busy} onClick={() => setEditing(false)}>{t('common.cancel')}</button>
        </form>
      ) : (
        <button type="button" className="ct-sync__nameButton" aria-label={t('sync.status.renameDevice', { name })} disabled={!ready} onClick={() => { setDraft(name); setEditing(true); }}>{name}</button>
      )}
      <span className="ct-sync__deviceId">{device.self && <><span>{t('sync.status.thisDeviceName')}</span>{' · '}</>}{device.deviceId}</span>
    </>
  );
}
