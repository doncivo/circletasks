import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { logDesktopFailure } from '../../platform';
import { Button, ConfirmDialog } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { createOnboardingUseCases } from './onboardingUseCases';

type Phase = 'hidden' | 'visible' | 'confirm' | 'done' | 'error';

/**
 * Ligne « Supprimer les données d'exemple » de Réglages › DONNÉES ET SÉCURITÉ (P-05 critère 6), affichée tant qu'il reste des éléments
 * d'exemple. Confirmation, puis tâches et checklist à la corbeille et routines archivées ; chaque retrait est annulable (bandeau « Annuler »).
 */
export function SampleDataRow() {
  const container = useAppContainer();
  const [phase, setPhase] = useState<Phase>('hidden');

  useEffect(() => {
    let active = true;
    createOnboardingUseCases(container)
      .sampleExists()
      .then((exists) => {
        if (active) setPhase(exists ? 'visible' : 'hidden');
      })
      .catch((error: unknown) => logDesktopFailure('sample-exists', error));
    return () => {
      active = false;
    };
  }, [container]);

  async function remove(): Promise<void> {
    setPhase('visible');
    try {
      await createOnboardingUseCases(container).removeSampleData();
      setPhase('done');
    } catch (error) {
      logDesktopFailure('sample-remove', error);
      setPhase('error');
    }
  }

  if (phase === 'hidden') return null;
  if (phase === 'done') {
    return (
      <div className="ct-settings__row">
        <span role="status">{t('onboarding.removeSampleDone')}</span>
      </div>
    );
  }
  return (
    <>
      <div className="ct-settings__row">
        <span className="ct-settings__stack">
          {t('onboarding.removeSample')}
          {phase === 'error' && (
            <span className="ct-settings__hint ct-settings__hint--danger" role="alert">
              {t('onboarding.removeSampleError')}
            </span>
          )}
        </span>
        <Button variant="secondary" ariaLabel={t('onboarding.removeSample')} onClick={() => setPhase('confirm')} className="ct-settings__link">
          {t('onboarding.removeSampleOpen')}
        </Button>
      </div>
      {phase === 'confirm' && (
        <ConfirmDialog
          title={t('onboarding.removeSampleConfirmTitle')}
          description={t('onboarding.removeSampleConfirmText')}
          confirmLabel={t('onboarding.removeSampleConfirm')}
          onCancel={() => setPhase('visible')}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}
