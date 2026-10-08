import { Undo2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { formatTime } from '../../i18n/format';
import { parseTimeInput } from '../../domain/dateInput';
import type { RecapKind, RecapSetting, RecapSettings } from '../../domain/recap';
import { t } from '../../i18n';
import { Button, Icon, Switch, TextField, useLayout } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { useNavigationStore } from '../app/navigation';
import { settingsStore } from '../settings/settingsStore';
import { RemindersStatusSection } from './RemindersStatusSection';
import './RecapSettingsScreen.css';

interface Draft {
  readonly enabled: boolean;
  readonly time: string;
}

type RecapErrorKey = 'reminders.recapOrderError' | 'reminders.recapTimeInvalid' | 'reminders.recapSaveError';

const draftOf = (setting: RecapSetting): Draft => ({ enabled: setting.enabled, time: formatTime(setting.time) });

/**
 * Écran « Récapitulatifs » (N-04), ouvert depuis Réglages › RAPPELS : « Matin » et « Soir », chacun avec un interrupteur et une heure
 * 24 h modifiable. Enregistrer refuse un soir qui ne suit pas le matin. Sur PC, indique que l'envoi se fait sur l'iPhone : aucun
 * récapitulatif n'est émis par le PC. L'écran n'est pas dessiné dans les maquettes (mêmes codes que Réglages).
 */
export function RecapSettingsScreen() {
  const layout = useLayout();
  const navigate = useNavigationStore((s) => s.navigate);
  const load = useFeatureStore(settingsStore, (s) => s.load);
  const status = useFeatureStore(settingsStore, (s) => s.status);
  const recaps = useFeatureStore(settingsStore, (s) => s.recaps);
  const saveRecaps = useFeatureStore(settingsStore, (s) => s.saveRecaps);
  const [morning, setMorning] = useState<Draft>(draftOf(recaps.morning));
  const [evening, setEvening] = useState<Draft>(draftOf(recaps.evening));
  const [loadedFrom, setLoadedFrom] = useState<RecapSettings>(recaps);
  const [errorKey, setErrorKey] = useState<RecapErrorKey | null>(null);

  useEffect(() => {
    void load();
  }, [load]);
  // Les réglages sont lus après l'ouverture : les champs suivent la valeur enregistrée.
  if (recaps !== loadedFrom) {
    setLoadedFrom(recaps);
    setMorning(draftOf(recaps.morning));
    setEvening(draftOf(recaps.evening));
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const m = parseTimeInput(morning.time);
    const e = parseTimeInput(evening.time);
    if (!m.ok || !e.ok || m.value === null || e.value === null) {
      setErrorKey('reminders.recapTimeInvalid');
      return;
    }
    const result = await saveRecaps({ morning: { enabled: morning.enabled, time: m.value }, evening: { enabled: evening.enabled, time: e.value } });
    if (result === 'ok') {
      setErrorKey(null);
      navigate({ tab: 'settings', screen: 'home' });
      return;
    }
    setErrorKey(result === 'evening-before-morning' ? 'reminders.recapOrderError' : result === 'invalid-time' ? 'reminders.recapTimeInvalid' : 'reminders.recapSaveError');
  }

  const section = (kind: RecapKind, draft: Draft, set: (next: Draft) => void) => {
    const label = t(kind === 'morning' ? 'reminders.recapMorning' : 'reminders.recapEvening');
    const switchLabel = t(kind === 'morning' ? 'reminders.recapMorningSwitch' : 'reminders.recapEveningSwitch');
    return (
      <section className="ct-recap__section" aria-label={label}>
        <div className="ct-recap__row">
          <h2 className="ct-recap__sectionTitle">{label}</h2>
          <Switch checked={draft.enabled} onChange={(enabled) => set({ ...draft, enabled })} label={switchLabel} disabled={status === 'loading'} />
        </div>
        <TextField
          label={t(kind === 'morning' ? 'reminders.recapMorningTime' : 'reminders.recapEveningTime')}
          value={draft.time}
          onChange={(time) => set({ ...draft, time })}
          placeholder={t('reminders.recapTimePlaceholder')}
        />
      </section>
    );
  };

  return (
    <div className="ct-recap-shell" data-layout={layout}>
      <form className="ct-recap" onSubmit={(event) => void submit(event)} noValidate>
        <div className="ct-recap__topRow">
          <button type="button" className="ct-recap__back" aria-label={t('trash.back')} onClick={() => navigate({ tab: 'settings', screen: 'home' })}>
            <Icon icon={Undo2} size={26} />
          </button>
        </div>
        <h1 className="ct-recap__title">{t('reminders.recapsTitle')}</h1>
        {layout === 'pc' && <p className="ct-recap__hint">{t('reminders.recapSentOnPhone')}</p>}
        {errorKey && (
          <p className="ct-recap__error" role="alert">
            {t(errorKey)}
          </p>
        )}
        {section('morning', morning, setMorning)}
        {section('evening', evening, setEvening)}
        <Button type="submit" fullWidth>
          {t('reminders.recapSave')}
        </Button>
        <RemindersStatusSection />
      </form>
    </div>
  );
}
