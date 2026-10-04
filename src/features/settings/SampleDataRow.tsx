import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { logDesktopFailure } from '../../platform';
import { Button, ConfirmDialog } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { onboardingStore } from './onboardingStore';
import { createOnboardingUseCases } from './onboardingUseCases';

type Phase = 'idle' | 'confirm' | 'done' | 'error';

/**
 * Ligne « Supprimer les données d'exemple » de Réglages › DONNÉES ET SÉCURITÉ (P-05 critère 6), affichée tant qu'il reste des éléments
 * d'exemple : l'état « exemples présents » vient du store de l'assistant, donc la ligne apparaît dès que l'assistant (premier lancement ou
 * « Revoir le guide ») les crée, sans rouvrir Réglages. Confirmation, puis tâches et checklist à la corbeille et routines archivées ; chaque
 * retrait est annulable (bandeau « Annuler »). Si la création des exemples a échoué à « Commencer », l'alerte s'affiche ici, hors de
 * l'assistant déjà fermé.
 */
export function SampleDataRow() {
  const container = useAppContainer();
  const present = useFeatureStore(onboardingStore, (s) => s.sampleExists);
  const creationFailed = useFeatureStore(onboardingStore, (s) => s.sampleError);
  const refreshSample = useFeatureStore(onboardingStore, (s) => s.refreshSample);
  const dismissSampleError = useFeatureStore(onboardingStore, (s) => s.dismissSampleError);
  const [storedPhase, setPhase] = useState<Phase>('idle');
  // Des exemples recréés (guide relancé) après une suppression : la ligne revient.
  const phase: Phase = present && storedPhase === 'done' ? 'idle' : storedPhase;

  useEffect(() => {
    void refreshSample();
  }, [refreshSample]);

  async function remove(): Promise<void> {
    setPhase('idle');
    try {
      await createOnboardingUseCases(container).removeSampleData();
      await refreshSample();
      setPhase('done');
    } catch (error) {
      logDesktopFailure('sample-remove', error);
      setPhase('error');
    }
  }

  const alert = creationFailed && (
    <div className="ct-settings__row">
      <span className="ct-settings__stack">
        <span className="ct-settings__hint ct-settings__hint--danger" role="alert">
          {t('onboarding.sampleError')}
        </span>
      </span>
      <Button variant="secondary" onClick={dismissSampleError} className="ct-settings__link">
        {t('common.close')}
      </Button>
    </div>
  );

  if (!present && phase !== 'done' && phase !== 'error') return <>{alert}</>;
  if (!present && phase === 'done') {
    return (
      <>
        {alert}
        <div className="ct-settings__row">
          <span role="status">{t('onboarding.removeSampleDone')}</span>
        </div>
      </>
    );
  }
  return (
    <>
      {alert}
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
          onCancel={() => setPhase('idle')}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}
