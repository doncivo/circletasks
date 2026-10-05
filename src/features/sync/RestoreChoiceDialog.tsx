import { useEffect, useRef } from 'react';
import type { RestoreOption } from '../../domain/sync/epoch';
import { t } from '../../i18n';
import { ChoiceDialog } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { syncStore } from './syncStore';

/**
 * Fenêtre de choix après une restauration P-04 (ADR 0010 règles 3 et 4, ADR 0011 section 9 ; Y-02 critère 13, Y-09 critère 8, Y-03 D2).
 * Sans maquette : composée avec `ChoiceDialog`. Ouverte d'elle-même quand la phase devient `restore-choice` (une fois par session), et
 * par « Synchroniser » pendant cette phase. Règle 4 : seule « Appliquer partout » si une suppression postérieure a déjà été purgée.
 * « Plus tard » ferme la fenêtre sans rien changer : aucune synchro ne part tant que le choix n'est pas fait.
 */
export function RestoreChoiceDialog() {
  const restore = useFeatureStore(syncStore, (s) => s.restore);
  const phase = useFeatureStore(syncStore, (s) => s.status.phase);
  const openRestore = useFeatureStore(syncStore, (s) => s.openRestore);
  const chooseRestore = useFeatureStore(syncStore, (s) => s.chooseRestore);
  const closeRestore = useFeatureStore(syncStore, (s) => s.closeRestore);
  const opened = useRef(false);

  useEffect(() => {
    if (phase === 'restore-choice' && !opened.current) {
      opened.current = true;
      void openRestore();
    }
  }, [phase, openRestore]);

  if (!restore) return null;
  const options = restore.options.map((id) => ({ id, label: t(id === 'apply-everywhere' ? 'sync.restore.applyEverywhere' : 'sync.restore.keepSynced') }));
  // Règle 4 : texte dédié (une seule clé, jamais deux phrases assemblées dans le code).
  const description = t(restore.options.includes('keep-synced') ? 'sync.restore.body' : 'sync.restore.bodyOnlyApply');
  return (
    <ChoiceDialog<RestoreOption>
      title={t('sync.restore.title')}
      description={description}
      options={options}
      cancelLabel={t('sync.restore.later')}
      onChoose={(option) => void chooseRestore(option)}
      onCancel={closeRestore}
    />
  );
}
