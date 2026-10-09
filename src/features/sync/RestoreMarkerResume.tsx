import { useState } from 'react';
import { t } from '../../i18n';
import { Button, ConfirmDialog } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { restoreMarkerFailure, resumeSyncDespiteMarker } from './startSync';

/**
 * P-04-iOS critère 12 (ADR 0009 avenant lot F B6) : la restauration est faite mais le marqueur de la synchro n'a pas pu être écrit ; aucun
 * cycle ne part. Même message que le bandeau, avec le code, et « Reprendre la synchronisation » : choix explicite, confirmé (« Annuler » par
 * défaut), qui efface le mémo.
 */
export function RestoreMarkerResume() {
  const container = useAppContainer();
  const [code, setCode] = useState(() => restoreMarkerFailure(container));
  const [confirming, setConfirming] = useState(false);
  if (!code) return null;
  return (
    <div className="ct-settings__row">
      <span className="ct-settings__stack" role="alert">
        {t('backup.markerFailed')}
        <span className="ct-settings__hint ct-settings__hint--missed">{t('backup.errorCode', { code })}</span>
      </span>
      <Button variant="secondary" onClick={() => setConfirming(true)} className="ct-settings__link">
        {t('backup.resumeSync')}
      </Button>
      {confirming && (
        <ConfirmDialog
          title={t('backup.resumeSyncTitle')}
          description={t('backup.resumeSyncText')}
          confirmLabel={t('backup.resumeSync')}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            resumeSyncDespiteMarker(container);
            setCode(null);
          }}
        />
      )}
    </div>
  );
}
