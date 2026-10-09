import { useState } from 'react';
import { rescueText } from '../../i18n/syncRescue';
import { Button, ConfirmDialog } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { syncStore } from './syncStore';

/**
 * Y-IOS-02 (ADR 0011 §24) : actions des avertissements de la synchro, avec confirmation (« Annuler » par défaut) :
 * - `awaiting-other-devices` : « Démarrer la synchro depuis cet appareil » (clé importée, aucun autre appareil lu : à n'utiliser que si tous les
 *   autres sont perdus ; les autres fusionneront ensuite dans celui-ci) ;
 * - `received-unapplied` : « Lancer une reprise complète » (reprise depuis l'instantané en fusion ; acquitte l'avertissement d'une trace).
 */
export function SyncDetailsRescue() {
  const container = useAppContainer();
  const warnings = useFeatureStore(syncStore, (s) => s.status.warnings) ?? [];
  const [open, setOpen] = useState<'start' | 'resume' | null>(null);
  const [busy, setBusy] = useState(false);
  const sync = container.sync;
  const awaiting = warnings.includes('awaiting-other-devices');
  const unapplied = warnings.includes('received-unapplied');
  if (!sync || (!awaiting && !unapplied)) return null;

  const run = async (kind: 'start' | 'resume'): Promise<void> => {
    setOpen(null);
    setBusy(true);
    try {
      if (kind === 'start') await sync.startFromThisDevice();
      else await sync.fullResume();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {awaiting && (
        <div className="ct-settings__row" data-action="start-here">
          <Button variant="secondary" onClick={() => setOpen('start')} disabled={busy} ariaBusy={busy} className="ct-settings__link">
            {rescueText('startHere')}
          </Button>
        </div>
      )}
      {unapplied && (
        <div className="ct-settings__row" data-action="full-resume">
          <Button variant="secondary" onClick={() => setOpen('resume')} disabled={busy} ariaBusy={busy} className="ct-settings__link">
            {rescueText('fullResume')}
          </Button>
        </div>
      )}
      {open === 'start' && (
        <ConfirmDialog title={rescueText('startHereTitle')} description={rescueText('startHereBody')} confirmLabel={rescueText('startHere')} onConfirm={() => void run('start')} onCancel={() => setOpen(null)} />
      )}
      {open === 'resume' && (
        <ConfirmDialog title={rescueText('fullResumeTitle')} description={rescueText('fullResumeBody')} confirmLabel={rescueText('fullResume')} onConfirm={() => void run('resume')} onCancel={() => setOpen(null)} />
      )}
    </>
  );
}
