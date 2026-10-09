import { useState } from 'react';
import { syncErrorFamily } from '../../domain/sync/errorFamily';
import { t, type PlainMessageKey } from '../../i18n';
import { syncErrorCodeOf } from '../../platform/sync/types';
import { Button } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { syncStore } from './syncStore';
import { chooseFolderAndBind, syncErrorMessageKey } from './SyncSettingsSection';

/**
 * QA du parcours d'association (D2) : dossier à choisir de nouveau (erreur de la famille `folder` : non lié, inutilisable, trop volumineux)
 * vu depuis Détails (où mène le bandeau A-09) : « Choisir le dossier » offert ici aussi, jamais une impasse. Même choix que Réglages
 * (`chooseFolderAndBind`) ; un échec est dit sur la ligne (role="status").
 */
export function SyncDetailsFolder() {
  const container = useAppContainer();
  const phase = useFeatureStore(syncStore, (s) => s.status.phase);
  const errorCode = useFeatureStore(syncStore, (s) => s.status.errorCode ?? null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PlainMessageKey | null>(null);
  const platform = container.syncPlatform;
  if (!platform || phase !== 'error' || syncErrorFamily(errorCode) !== 'folder') return null;
  const ios = container.platform.os === 'ios';

  const choose = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await chooseFolderAndBind(container, platform, ios);
    } catch (error) {
      setFailure(syncErrorMessageKey(syncErrorCodeOf(error), ios));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ct-settings__row" data-testid="sync-details-folder">
      <span className="ct-settings__stack">
        {t('sync.folder.rowLabel')}
        {failure && (
          <span className="ct-settings__hint ct-settings__hint--danger" role="status">
            {t(failure)}
          </span>
        )}
      </span>
      <Button variant="secondary" ariaLabel={t('sync.folder.chooseLabel')} onClick={() => void choose()} className="ct-settings__link" disabled={busy}>
        {busy ? t('sync.folder.choosing') : t('sync.folder.choose')}
      </Button>
    </div>
  );
}
