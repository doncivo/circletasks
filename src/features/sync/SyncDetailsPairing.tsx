import { useEffect, useRef, useState } from 'react';
import { t, type PlainMessageKey } from '../../i18n';
import { Button } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { JoinProgress } from './JoinProgress';
import { onPairingChange, openPairingWindow, pairingOpenErrorKey, pairingStorageFailed, readPairingFailure, type PairingFailure } from './pairingStatus';
import { syncStore } from './syncStore';

type Notice = { readonly key: PlainMessageKey; readonly tone: 'ok' | 'danger' };

/**
 * Emplacement « appairage » de l'écran de détails (Y-06 critères 4, 9, 10 et 13 ; D1 ; sans maquette PC, ligne de Réglages) :
 * « Associer l'iPhone » (instance `show`, confirmation native ouverte par Rust) quand cet appareil a la clé, « Associer cet appareil »
 * (instance `import`, clé de secours) quand le dossier est lié sans clé. Messages annoncés (`role="status"`) ; un échec d'ouverture
 * reste affiché, même après un redémarrage, jusqu'à la prochaine ouverture réussie ou l'association. « iPhone associé » à l'arrivée.
 * Aucune clé ne passe par cette fenêtre.
 */
export function SyncDetailsPairing({ showOnly = false, withProgress = true }: { readonly showOnly?: boolean; readonly withProgress?: boolean } = {}) {
  const container = useAppContainer();
  const phase = useFeatureStore(syncStore, (s) => s.status.phase);
  const [failure, setFailure] = useState<PairingFailure | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const lastMode = useRef<'show' | 'import' | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      void readPairingFailure(container).then((value) => {
        if (!cancelled) setFailure(value);
      });
    };
    refresh();
    const stop = onPairingChange(container, (event) => {
      if (event === 'paired') setNotice({ key: lastMode.current === 'import' ? 'sync.pairing.thisDevicePaired' : 'sync.pairing.paired', tone: 'ok' });
      if (event === 'paired-sync-failed') setNotice({ key: lastMode.current === 'import' ? 'sync.pairing.thisDevicePairedSyncFailed' : 'sync.pairing.pairedSyncFailed', tone: 'danger' });
      setStorageFailed(pairingStorageFailed(container));
      refresh();
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [container]);

  if (!container.syncPlatform || phase === 'not-configured') return null;
  // Y-11 : un appareil à associer de nouveau (réinitialisation annoncée ailleurs) importe la nouvelle clé ; il ne montre jamais l'ancienne.
  const mode: 'show' | 'import' = phase === 'needs-pairing' || phase === 'key-mismatch' || phase === 'reset-required' ? 'import' : 'show';
  // Assistant du premier lancement : « Associer cet appareil » est déjà sur la ligne de `SyncSettingsSection`.
  if (showOnly && mode === 'import') return null;

  const open = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    lastMode.current = mode;
    try {
      const code = await openPairingWindow(container, mode);
      if (code) setNotice({ key: pairingOpenErrorKey(code, mode), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  // Échec gardé du même mode seulement (un échec de l'instance import ne s'affiche pas sous « Associer l'iPhone »).
  const shownFailure: PlainMessageKey | null = storageFailed
    ? 'sync.pairing.stateUnavailable'
    : notice === null && failure !== null && failure.mode === mode
      ? pairingOpenErrorKey(failure.code, mode)
      : null;
  return (
    <>
      <div className="ct-settings__row ct-sync__pairing">
        <span className="ct-settings__stack">
          {t('sync.pairing.rowLabel')}
          {notice && (
            <span className={notice.tone === 'ok' ? 'ct-settings__hint ct-sync__ok' : 'ct-settings__hint ct-settings__hint--danger'} role="status" data-testid="sync-pairing-notice">
              {t(notice.key)}
            </span>
          )}
          {shownFailure && (notice === null || storageFailed) && (
            <span className="ct-settings__hint ct-settings__hint--danger" role="status" data-testid={notice ? 'sync-pairing-storage' : 'sync-pairing-notice'}>
              {t(shownFailure)}
            </span>
          )}
        </span>
        <Button variant="secondary" className="ct-settings__link" ariaLabel={mode === 'show' ? t('sync.pairing.showLabel') : t('sync.pairing.importLabel')} disabled={busy} onClick={() => void open()}>
          {busy ? t('sync.pairing.opening') : mode === 'show' ? t('sync.pairing.show') : t('sync.pairing.importAction')}
        </Button>
      </div>
      {withProgress && <JoinProgress />}
    </>
  );
}
