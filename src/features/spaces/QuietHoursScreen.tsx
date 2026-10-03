import { Trash2, Undo2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { parseTimeInput } from '../../domain/dateInput';
import type { QuietHours, Space } from '../../domain/model';
import { allDayRange, isAllDayRange } from '../../domain/quietHours';
import type { LocalTime, Weekday } from '../../domain/types';
import { t } from '../../i18n';
import { Button, Icon, Switch, TextField, WeekdayToggles, spaceTextColor, useLayout } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { spacesStore } from './spacesStore';
import './QuietHoursScreen.css';

interface RangeDraft {
  readonly key: number;
  readonly weekdays: readonly Weekday[];
  readonly from: string;
  readonly to: string;
  readonly allDay: boolean;
}

let nextKey = 1;

const draftOf = (range: QuietHours): RangeDraft => ({ key: nextKey++, weekdays: range.weekdays, from: range.from, to: range.to, allDay: isAllDayRange(range) });

/** Nouvelle plage proposée : les soirs de semaine, 19:00 → 08:00. */
const newDraft = (): RangeDraft => ({ key: nextKey++, weekdays: [1, 2, 3, 4, 5], from: '19:00', to: '08:00', allDay: false });

/**
 * Éditeur des plages silencieuses d'un espace (ES-07 critère 3), ouvert depuis « Silence Pro » de Réglages › RAPPELS : ajouter,
 * modifier, supprimer une plage (jours L à D, début et fin en 24 h, ou « Toute la journée »). Enregistrer refuse une plage sans jour,
 * à l'heure illisible ou dont le début égale la fin hors « Toute la journée » (critère 4) ; l'ancien réglage reste alors. Écran non
 * dessiné dans les maquettes (mêmes codes que Réglages). Aucune notification n'est émise : l'envoi relève de l'iPhone (ordre 5).
 */
export function QuietHoursScreen({ space }: { readonly space: Space }) {
  const layout = useLayout();
  const navigate = useNavigationStore((s) => s.navigate);
  const saveQuietHours = useFeatureStore(spacesStore, (s) => s.saveQuietHours);
  const spaceName = useAppStore((s) => s.spaces.find((candidate) => candidate.id === space.id)?.name ?? space.name);
  const [ranges, setRanges] = useState<readonly RangeDraft[]>(() => space.quietHours.map(draftOf));
  const [errorText, setErrorText] = useState<string | null>(null);
  const home = (): void => navigate({ tab: 'settings', screen: 'home' });

  const change = (key: number, patch: Partial<RangeDraft>): void => {
    setErrorText(null);
    setRanges((current) => current.map((range) => (range.key === key ? { ...range, ...patch } : range)));
  };

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const built: QuietHours[] = [];
    for (const [index, draft] of ranges.entries()) {
      const number = index + 1;
      if (draft.weekdays.length === 0) {
        setErrorText(t('spaces.quietNoDays', { number }));
        return;
      }
      if (draft.allDay) {
        built.push(allDayRange(draft.weekdays));
        continue;
      }
      const from = parseTimeInput(draft.from);
      const to = parseTimeInput(draft.to);
      if (!from.ok || !to.ok || from.value === null || to.value === null) {
        setErrorText(t('spaces.quietTimeInvalid', { number }));
        return;
      }
      built.push({ weekdays: draft.weekdays, from: from.value as LocalTime, to: to.value as LocalTime });
    }
    const outcome = await saveQuietHours(space.id, built);
    if (outcome === 'ok') {
      home();
      return;
    }
    if (outcome === 'error') {
      setErrorText(t('spaces.saveError'));
      return;
    }
    const number = outcome.index + 1;
    setErrorText(
      outcome.error === 'empty-range'
        ? t('spaces.quietEmptyRange', { number })
        : outcome.error === 'no-days' || outcome.error === 'invalid-day'
          ? t('spaces.quietNoDays', { number })
          : t('spaces.quietTimeInvalid', { number }),
    );
  }

  return (
    <div className="ct-quiet-shell" data-layout={layout}>
      <form className="ct-quiet" onSubmit={(event) => void submit(event)} noValidate>
        <div className="ct-quiet__topRow">
          <button type="button" className="ct-quiet__back" aria-label={t('spaces.back')} onClick={home}>
            <Icon icon={Undo2} size={26} />
          </button>
        </div>
        <h1 className="ct-quiet__title">
          {t('spaces.quietRowPrefix')} <span style={{ color: spaceTextColor(space.color) }}>{spaceName}</span>
        </h1>
        <p className="ct-quiet__hint">{t('spaces.quietHint')}</p>
        {layout === 'pc' && <p className="ct-quiet__hint">{t('spaces.quietSentOnPhone')}</p>}
        {errorText && (
          <p className="ct-quiet__error" role="alert">
            {errorText}
          </p>
        )}
        {ranges.length === 0 && <p className="ct-quiet__empty">{t('spaces.quietEmpty')}</p>}
        {ranges.map((range, index) => {
          const number = index + 1;
          return (
            <section key={range.key} className="ct-quiet__range" aria-label={t('spaces.quietRangeTitle', { number })}>
              <div className="ct-quiet__rangeHead">
                <h2 className="ct-quiet__rangeTitle">{t('spaces.quietRangeTitle', { number })}</h2>
                <button type="button" className="ct-quiet__delete" aria-label={t('spaces.quietDelete', { number })} onClick={() => setRanges((current) => current.filter((r) => r.key !== range.key))}>
                  <Icon icon={Trash2} size={22} />
                </button>
              </div>
              <WeekdayToggles
                label={t('spaces.quietDaysGroup', { number })}
                value={range.weekdays}
                onToggle={(day) => change(range.key, { weekdays: range.weekdays.includes(day) ? range.weekdays.filter((d) => d !== day) : [...range.weekdays, day].sort((a, b) => a - b) })}
              />
              <div className="ct-quiet__row">
                <span>{t('spaces.quietAllDayLabel')}</span>
                <Switch checked={range.allDay} onChange={(allDay) => change(range.key, { allDay })} label={t('spaces.quietAllDaySwitch', { number })} />
              </div>
              {!range.allDay && (
                <div className="ct-quiet__times">
                  <TextField label={t('spaces.quietFrom', { number })} value={range.from} onChange={(from) => change(range.key, { from })} />
                  <TextField label={t('spaces.quietTo', { number })} value={range.to} onChange={(to) => change(range.key, { to })} />
                </div>
              )}
            </section>
          );
        })}
        <button type="button" className="ct-quiet__add" onClick={() => setRanges((current) => [...current, newDraft()])}>
          {t('spaces.quietAdd')}
        </button>
        <Button type="submit" fullWidth>
          {t('spaces.quietSave')}
        </Button>
      </form>
    </div>
  );
}
