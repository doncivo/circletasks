import { useEffect, useRef, useState } from 'react';
import { t, type PlainMessageKey } from '../../i18n';
import type { SyncErrorCode } from '../../platform/sync/types';
import { Button } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { JoinProgress } from './JoinProgress';
import { onPairingChange, openPairingWindow, readPairingFailure, type PairingFailure } from './pairingStatus';
import { syncStore } from './syncStore';

/** Texte d'un échec d'ouverture de la fenêtre `pairing` (jamais une boîte bloquante, Y-06 critère 4). */
export function pairingOpenErrorKey(code: SyncErrorCode, appFocused: boolean): PlainMessageKey {
  switch (code) {
    case 'consent-denied':
      // Même code pour un refus de la boîte et pour une app qui n'était pas au premier plan : l'état du focus au moment de l'appel
      // départage (une app sans le focus voit sa demande refusée sans boîte).
      return appFocused ? 'sync.pairing.openDenied' : 'sync.pairing.openBackground';
    case 'rate-limited':
      return 'sync.pairing.openRateLimited';
    case 'io':
      return 'sync.pairing.openIncomplete';
    default:
      return 'sync.pairing.openFailed';
  }
}

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
      refresh();
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [container]);

  if (!container.syncPlatform || phase === 'not-configured') return null;
  const mode: 'show' | 'import' = phase === 'needs-pairing' || phase === 'key-mismatch' ? 'import' : 'show';
  // Assistant du premier lancement : « Associer cet appareil » est déjà sur la ligne de `SyncSettingsSection`.
  if (showOnly && mode === 'import') return null;

  const open = async (): Promise<void> => {
    const focused = typeof document === 'undefined' || document.hasFocus();
    setBusy(true);
    setNotice(null);
    lastMode.current = mode;
    try {
      const code = await openPairingWindow(container, mode);
      if (code) setNotice({ key: pairingOpenErrorKey(code, focused), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const shownFailure = notice === null && failure !== null ? pairingOpenErrorKey(failure.code, true) : null;
  return (
    <>
      <div className="ct-settings__row ct-sync__pairing">
        <span className="ct-settings__stack">
          {t('sync.pairing.rowLabel')}
          {(notice || shownFailure) && (
            <span className={notice?.tone === 'ok' ? 'ct-settings__hint ct-sync__ok' : 'ct-settings__hint ct-settings__hint--danger'} role="status" data-testid="sync-pairing-notice">
              {t(notice?.key ?? (shownFailure as PlainMessageKey))}
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
