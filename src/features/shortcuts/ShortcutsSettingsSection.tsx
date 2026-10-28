import { useEffect, type KeyboardEvent } from 'react';
import { t } from '../../i18n';
import { tSettingsRefonte } from '../../i18n/settingsRefonteText';
import { Button, Kbd, Switch, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useNavigationStore } from '../app/navigation';
import { formatChord } from '../app/shortcutsHelp';
import { chordFromEvent } from './chordFromEvent';
import { quickCaptureStore } from './quickCaptureStore';
import { DEFAULT_QUICK_CAPTURE_KEYS } from './quickCaptureUseCases';
import './ShortcutsSettingsSection.css';

/**
 * Section « Clavier » de Réglages (PC seulement, D-04 et P-08 ; UI-REFONTE-09, PC-Reglages.html) : dans l'app installée, la ligne
 * « Capture rapide » (combinaison globale configurable ; une combinaison prise par une autre application s'explique en une phrase sous
 * l'étiquette, touche en ambre), puis la ligne cliquable « Tous les raccourcis · Ctrl / » (ouvre la liste). Le titre reste au sommaire
 * du PC (`heading={false}`). Absente sur iPhone : pas de clavier.
 */
export function ShortcutsSettingsSection({ heading = true }: { readonly heading?: boolean } = {}) {
  const layout = useLayout();
  const container = useAppContainer();
  const openOverlay = useNavigationStore((s) => s.openOverlay);
  if (layout !== 'pc') return null;
  return (
    <>
      {heading && <h2 className="ct-settings__section">{t('shortcutsUi.settings.section')}</h2>}
      {container.desktop && <QuickCaptureRow />}
      <button
        type="button"
        className="ct-settings__row ct-settings__rowButton"
        aria-label={t('shortcutsUi.openHelpLabel')}
        onClick={() => openOverlay({ kind: 'shortcutsHelp' })}
      >
        <span>{tSettingsRefonte('allShortcuts')}</span>
        <Kbd keys="Ctrl+/" separator=" " className="ct-settings__kbd" />
      </button>
    </>
  );
}

function QuickCaptureRow() {
  const loaded = useFeatureStore(quickCaptureStore, (s) => s.loaded);
  const keys = useFeatureStore(quickCaptureStore, (s) => s.keys);
  const status = useFeatureStore(quickCaptureStore, (s) => s.status);
  const capturing = useFeatureStore(quickCaptureStore, (s) => s.capturing);
  const errorKey = useFeatureStore(quickCaptureStore, (s) => s.errorKey);
  const announcement = useFeatureStore(quickCaptureStore, (s) => s.announcement);
  const init = useFeatureStore(quickCaptureStore, (s) => s.init);
  const beginCapture = useFeatureStore(quickCaptureStore, (s) => s.beginCapture);
  const cancelCapture = useFeatureStore(quickCaptureStore, (s) => s.cancelCapture);
  const rejectChord = useFeatureStore(quickCaptureStore, (s) => s.rejectChord);
  const applyChord = useFeatureStore(quickCaptureStore, (s) => s.applyChord);
  const setEnabled = useFeatureStore(quickCaptureStore, (s) => s.setEnabled);
  const reset = useFeatureStore(quickCaptureStore, (s) => s.reset);

  useEffect(() => {
    if (!loaded) void init();
  }, [loaded, init]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (!capturing) return;
    // La combinaison saisie ne doit déclencher aucun raccourci de l'application (écouteur de la fenêtre).
    event.preventDefault();
    event.nativeEvent.stopPropagation();
    if (event.key === 'Escape') {
      cancelCapture();
      return;
    }
    const captured = chordFromEvent(event.nativeEvent);
    if (captured.kind === 'waiting') return;
    if (captured.kind === 'error') {
      rejectChord(captured.errorKey);
      return;
    }
    void applyChord(captured.keys);
  }


  const shown = formatChord(keys);
  const off = status === 'off';
  const taken = loaded && status === 'unavailable' && !errorKey;
  return (
    <>
      <div className="ct-settings__row">
        <span className="ct-settings__stack">
          <span>{t('shortcutsUi.settings.quickCapture')}</span>
          {taken && (
            <span className="ct-settings__hint" data-tone="warning">
              {tSettingsRefonte('quickCaptureTaken', { keys: shown })}
            </span>
          )}
        </span>
        <span className="ct-quickcapture">
          {loaded && (
            <button
              type="button"
              className="ct-quickcapture__key"
              data-capturing={capturing || undefined}
              data-state={status}
              aria-label={t('shortcutsUi.settings.quickCaptureChange', { keys: shown })}
              disabled={off}
              onClick={() => (capturing ? cancelCapture() : beginCapture())}
              onKeyDown={onKeyDown}
              onBlur={() => capturing && cancelCapture()}
            >
              {capturing ? t('shortcutsUi.settings.capturePrompt') : shown}
            </button>
          )}
          <Switch
            checked={!off}
            onChange={(value) => void setEnabled(value)}
            label={t('shortcutsUi.settings.quickCaptureEnabled')}
            disabled={!loaded}
          />
        </span>
      </div>
      {loaded && keys !== DEFAULT_QUICK_CAPTURE_KEYS && (
        <div className="ct-settings__row">
          <span />
          <Button variant="secondary" onClick={() => void reset()} className="ct-settings__link">
            {t('shortcutsUi.settings.reset', { keys: formatChord(DEFAULT_QUICK_CAPTURE_KEYS) })}
          </Button>
        </div>
      )}
      {errorKey && (
        <p className="ct-quickcapture__note" role="alert">
          {t(errorKey)}
        </p>
      )}
      <p className="ct-quickcapture__live" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}
