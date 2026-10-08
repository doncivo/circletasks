import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import type { CameraPermission, SyncPlatform } from '../../platform/sync/types';
import { Button } from '../../ui';
import { openCameraSettings } from '../security/excursion';

/**
 * Ligne « Associer au PC » de Réglages › Synchronisation sur l'iPhone (ADR 0011 §23 points 2 et 7 ; Y-IOS-02 critères 6 et 7) : ouvre
 * l'écran d'association. Tant que l'iPhone n'est pas associé, l'autorisation de la caméra est lue du système à l'affichage et à chaque retour
 * au premier plan : refusée, la ligne le dit (« L'accès à la caméra est refusé ») avec « Ouvrir les réglages » ; l'état disparaît quand
 * l'autorisation est rendue (iOS le garde : rien à stocker). Le bandeau persistant reste celui de `needs-pairing`. L'écran est tenu par
 * l'appelant (`onOpen`) : il reste ouvert quand l'association fait disparaître cette ligne (progression de l'arrivée).
 */
export function IosPairingRow({ platform, onOpen }: { readonly platform: SyncPlatform; readonly onOpen: () => void }) {
  const [camera, setCamera] = useState<CameraPermission>('prompt');

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void (platform.key.cameraPermission?.() ?? Promise.resolve<CameraPermission>('prompt')).then((state) => {
        if (active) setCamera(state);
      });
    };
    refresh();
    const onVisibility = (): void => {
      if (document.visibilityState !== 'hidden') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [platform]);

  return (
    <>
      <div className="ct-settings__row">
        <span className="ct-settings__stack">
          {t('sync.pairing.ios.open')}
          {camera === 'denied' && (
            <span className="ct-settings__hint ct-settings__hint--danger" role="status" data-testid="sync-camera-denied">
              {t('sync.pairing.ios.cameraDenied')}
            </span>
          )}
        </span>
        {camera === 'denied' && platform.key.openCameraSettings && (
          <Button variant="secondary" className="ct-settings__link" ariaLabel={t('sync.pairing.ios.openSettingsLabel')} onClick={() => void openCameraSettings(platform)}>
            {t('sync.pairing.ios.openSettings')}
          </Button>
        )}
        <Button variant="secondary" className="ct-settings__link" ariaLabel={t('sync.pairing.ios.openLabel')} onClick={onOpen}>
          {t('sync.pairing.ios.open')}
        </Button>
      </div>
    </>
  );
}
