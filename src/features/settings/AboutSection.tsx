import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { logDesktopFailure } from '../../platform';
import { Button } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useNavigationStore } from '../app/navigation';
import { updaterStore } from '../updater';
import { useLogJournal, useLogStatus } from './logs/useLogJournal';
import { onboardingStore } from './onboardingStore';

/**
 * Section « À PROPOS » (Reglages.html, D-03 critères 6 et 7, P-05 critère 8, I-04 critère 1). Partout : ligne « Version … » avec le lien
 * « Logs » (écran du journal technique ; un échec d'écriture ou de lecture du journal y est signalé en rouge, critère 10). Sur PC : version installée, « Rechercher une mise à jour »
 * (résultat : « CircleTasks est à jour », « Impossible de vérifier les mises à jour » ou le bandeau de mise à jour) et lien vers la dernière
 * version. Partout (PC et iPhone) : « Revoir le guide de bienvenue », qui relance l'assistant sans toucher aux données. L'iPhone se met à
 * jour par SideStore (I-06) : il n'y a pas de ligne de mise à jour.
 */
export function AboutSection() {
  const container = useAppContainer();
  const desktop = container.desktop;
  const status = useFeatureStore(updaterStore, (s) => s.status);
  const check = useFeatureStore(updaterStore, (s) => s.check);
  const relaunchGuide = useFeatureStore(onboardingStore, (s) => s.relaunch);
  const [version, setVersion] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const navigate = useNavigationStore((s) => s.navigate);
  const { journal, unavailable: journalUnavailable } = useLogJournal();
  const logStatus = useLogStatus(journal);
  const logFailureCode = logStatus.writeError ?? logStatus.readError ?? journalUnavailable;
  const runtime = container.platform.runtime;

  useEffect(() => {
    let active = true;
    // PC : version de l'intégration ; iPhone et navigateur : version de l'app (`@tauri-apps/api/app`), chargée à la demande.
    const read = desktop ? desktop.getVersion() : import('../../platform/logs').then((m) => m.appVersion(runtime));
    read
      .then((value) => {
        if (active) setVersion(value);
      })
      .catch((error: unknown) => logDesktopFailure('version', error));
    return () => {
      active = false;
    };
  }, [desktop, runtime]);

  const checking = status === 'checking';
  const hint =
    status === 'checking'
      ? t('settings.checkingUpdates')
      : status === 'upToDate'
        ? t('settings.upToDate')
        : status === 'checkFailed'
          ? t('settings.updateCheckFailed')
          : null;

  function openLatest(): void {
    setOpenFailed(false);
    desktop?.openLatestRelease().catch((error: unknown) => {
      logDesktopFailure('open-release', error);
      setOpenFailed(true);
    });
  }

  return (
    <>
      <h2 className="ct-settings__section">{t('settings.sectionAbout')}</h2>
      <div className="ct-settings__row">
        <span className="ct-settings__stack">
          {version ? t('app.version', { version }) : t('app.name')}
          {hint && (
            <span className={status === 'checkFailed' ? 'ct-settings__hint ct-settings__hint--danger' : 'ct-settings__hint'} role="status">
              {hint}
            </span>
          )}
          {logFailureCode && (
            <span className="ct-settings__hint ct-settings__hint--missed" role="alert">
              {logStatus.writeError ? t('logs.writeError') : logStatus.readError ? t('logs.readError') : t('logs.unavailable')} {t('logs.errorCode', { code: logFailureCode })}
            </span>
          )}
        </span>
        <span className="ct-settings__actions">
          <Button variant="secondary" ariaLabel={t('logs.rowOpenLabel')} onClick={() => navigate({ tab: 'settings', screen: 'logs' })} className="ct-settings__link">
            {t('logs.rowLabel')}
          </Button>
          {desktop && (
            <Button variant="secondary" onClick={() => void check()} disabled={checking} className="ct-settings__link">
              {t('settings.checkUpdates')}
            </Button>
          )}
        </span>
      </div>
      {desktop && (
        <>
          <div className="ct-settings__row">
            <span className="ct-settings__stack">
              {t('settings.latestRelease')}
              {openFailed && (
                <span className="ct-settings__hint ct-settings__hint--danger" role="alert">
                  {t('settings.openReleaseError')}
                </span>
              )}
            </span>
            <Button variant="secondary" ariaLabel={t('settings.latestReleaseOpenLabel')} onClick={openLatest} className="ct-settings__link">
              {t('settings.latestReleaseOpen')}
            </Button>
          </div>
        </>
      )}
      <div className="ct-settings__row">
        <span>{t('onboarding.guideRow')}</span>
        <Button variant="secondary" ariaLabel={t('onboarding.guideOpenLabel')} onClick={() => void relaunchGuide()} className="ct-settings__link">
          {t('onboarding.guideOpen')}
        </Button>
      </div>
    </>
  );
}
