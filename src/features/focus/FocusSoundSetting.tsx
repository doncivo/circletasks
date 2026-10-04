import { t } from '../../i18n';
import { Switch } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { focusStore } from './focusStore';

/**
 * Interrupteur « Son de fin de session » (Réglages › TÂCHES, F-04 critère 3 et D2) : réglage local à l'appareil, activé par défaut.
 * Même ligne que « Reporter les tâches non faites » (Reglages.html).
 */
export function FocusSoundSetting() {
  const endSound = useFeatureStore(focusStore, (s) => s.endSound);
  const setEndSound = useFeatureStore(focusStore, (s) => s.setEndSound);
  return (
    <div className="ct-settings__row">
      <span>{t('focus.endSoundSetting')}</span>
      <Switch checked={endSound} onChange={setEndSound} label={t('focus.endSoundSetting')} />
    </div>
  );
}
