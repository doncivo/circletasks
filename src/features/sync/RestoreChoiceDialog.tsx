import { useEffect, useRef } from 'react';
import type { RestoreOption } from '../../domain/sync/epoch';
import type { RestoreContext } from '../../platform/sync/types';
import { ChoiceDialog } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { resetReason } from './resetReason';
import { syncStore } from './syncStore';
import { tRestore } from '../../i18n/syncRestoreText';

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
  const options = restore.options.map((id) => ({ id, label: tRestore(id === 'apply-everywhere' ? 'applyEverywhere' : 'keepSynced') }));
  return (
    <ChoiceDialog<RestoreOption>
      title={tRestore('title')}
      description={restoreDescription(restore)}
      options={options}
      cancelLabel={tRestore('later')}
      onChoose={(option) => void chooseRestore(option)}
      onCancel={closeRestore}
    />
  );
}

/**
 * Texte de la fenêtre (une seule clé par cas, jamais deux phrases assemblées dans le code) : choix refusé ou en échec (QA-1, gardé jusqu'à
 * un choix appliqué), réinitialisation en cours (§18 point 16 : « Appliquer partout » retiré ; règle 4 : aucune option), règle 4, cas
 * ordinaire.
 */
function restoreDescription(restore: RestoreContext): string {
  const inReset = restore.notice === 'reset-in-progress' || restore.notice === 'reset-finish';
  if (restore.failure) return inReset ? tRestore('failedReset') : tRestore('failed', { reason: resetReason(restore.failure.code) });
  if (restore.notice === 'scan-failed') return tRestore(restore.options.length > 0 ? 'scanFailed' : 'scanFailedNoOption');
  if (restore.notice === 'provisional') return tRestore(restore.options.length > 0 ? 'provisional' : 'provisionalNoOption');
  if (restore.notice === 'reset-finish') return tRestore('resetFinish');
  if (restore.notice === 'reset-in-progress') return tRestore('resetInProgress');
  return tRestore(restore.options.includes('keep-synced') ? 'body' : 'bodyOnlyApply');
}
