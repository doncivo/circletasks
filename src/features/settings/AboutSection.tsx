import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { logDesktopFailure } from '../../platform';
import { Button } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { updaterStore } from '../updater';

/**
 * Section « À PROPOS » du PC (Reglages.html, D-03 critères 6 et 7) : version installée,
 * « Rechercher une mise à jour » (résultat : « CircleTasks est à jour », « Impossible de
 * vérifier les mises à jour » ou le bandeau de mise à jour) et lien vers la dernière version.
 * Absente hors PC : l'iPhone se met à jour par SideStore (I-06).
 */
export function AboutSection() {
  const container = useAppContainer();
  const desktop = container.desktop;
  const status = useFeatureStore(updaterStore, (s) => s.status);
  const check = useFeatureStore(updaterStore, (s) => s.check);
  const [version, setVersion] = useState<string | null>(null);
  const [openFailed, setOpenFailed] = useState(false);

  useEffect(() => {
    if (!desktop) return undefined;
    let active = true;
    desktop
      .getVersion()
      .then((value) => {
        if (active) setVersion(value);
      })
      .catch((error: unknown) => logDesktopFailure('version', error));
    return () => {
      active = false;
    };
  }, [desktop]);

  if (!desktop) return null;

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
        </span>
        <Button variant="secondary" onClick={() => void check()} disabled={checking} className="ct-settings__link">
          {t('settings.checkUpdates')}
        </Button>
      </div>
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
  );
}
