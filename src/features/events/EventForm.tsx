import { Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { DateChoice } from '../../domain/dateInput';
import { defaultEventEnd, endAfterStartChange, EVENT_TITLE_MAX, eventDurationMin, validateEvent, validateEventTitle } from '../../domain/eventRules';
import { EVENT_REMINDER_CHOICES, toggleEventReminderOffset } from '../../domain/eventReminders';
import { parseLocalDate } from '../../domain/localDate';
import type { CalendarEvent, EventFields, EventRepeat, IconRef, ReminderOffsetMin, Space } from '../../domain/model';
import type { LocalDate, LocalTime, SpaceId } from '../../domain/types';
import { t, type PlainMessageKey } from '../../i18n';
import { AddSegments, Button, DatePicker, Icon, IconChooser, SpaceSegmented, TextField, useLayout, type AddSegment } from '../../ui';
import { EventDateWheels } from './EventDateWheels';
import type { EventInput } from './eventUseCases';
import './EventForm.css';

export interface EventFormProps {
  /** Événement modifié ; null : création. */
  readonly event: CalendarEvent | null;
  readonly spaces: readonly Space[];
  /** Espace proposé à la création (ES-02 : filtre actif, sinon Pro). */
  readonly initialSpaceId: SpaceId;
  readonly today: LocalDate;
  /** Jour proposé à la création (jour touché dans le calendrier) ; aujourd'hui par défaut. */
  readonly initialDate?: LocalDate;
  /** Titre déjà saisi dans un autre segment de la feuille Ajout (E-01 critère 2). */
  readonly initialTitle?: string;
  /** Avances des rappels actuels de l'événement modifié. */
  readonly initialOffsets?: readonly ReminderOffsetMin[];
  /** Enregistre ; renvoie vrai si c'est fait (la feuille se ferme alors), faux sinon (elle reste ouverte). */
  readonly onSubmit: (input: EventInput) => Promise<boolean>;
  readonly onClose: () => void;
  /** Bouton « Supprimer l'événement » de la modification (E-01 critère 7). */
  readonly onDelete?: () => void;
  /** Affiche les segments Tâche / Événement / Routine (feuille Ajout) ; appelé avec le segment choisi et le titre saisi. */
  readonly onSegmentChange?: (segment: AddSegment, title: string) => void;
  readonly errorMessage: string | null;
  /** Focus dans le titre à l'ouverture. */
  readonly autoFocus?: boolean;
}

const DEFAULT_START_TIME = '09:00' as LocalTime;

const REPEATS: readonly { readonly value: EventRepeat; readonly labelKey: PlainMessageKey }[] = [
  { value: 'once', labelKey: 'events.sheet.repeatOnce' },
  { value: 'monthly', labelKey: 'events.sheet.repeatMonthly' },
  { value: 'yearly', labelKey: 'events.sheet.repeatYearly' },
];

const REMINDER_LABELS: Readonly<Record<number, PlainMessageKey>> = {
  10080: 'events.sheet.reminder10080',
  1440: 'events.sheet.reminder1440',
  0: 'events.sheet.reminder0',
};

/** Case ou bouton radio natif, dessiné comme AjoutEvenement.html (.dot rond, .box carré). */
function Choice({ type, name, checked, onChange, children }: { type: 'radio' | 'checkbox'; name?: string; checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label className="ct-event-form__choice" data-checked={checked}>
      <input type={type} name={name} className="ct-event-form__input" data-type={type} checked={checked} onChange={onChange} />
      {children}
    </label>
  );
}

/**
 * Feuille « Nouvel événement » / « Modifier l'événement » (E-01, AjoutEvenement.html) : titre (1 à 200 caractères), icône, date ou
 * plage horaire, répétition (Une fois / Mensuel / Annuel), rappels (1 semaine avant / La veille / Le jour même) et espace
 * (défaut ES-02). « Journée entière (commence et finit le même jour) » : un seul jour, sans heure ; décochée, Début et Fin
 * (date + heure) apparaissent, fin >= début, durée par défaut 1 h. Une modification s'applique à toute la série.
 */
export function EventForm({ event, spaces, initialSpaceId, today, initialDate, initialTitle = '', initialOffsets = [], onSubmit, onClose, onDelete, onSegmentChange, errorMessage, autoFocus }: EventFormProps) {
  const headingId = useId();
  const layout = useLayout();
  const titleRef = useRef<HTMLInputElement>(null);
  const radioName = useId();
  const [title, setTitle] = useState(event?.title ?? initialTitle);
  const [icon, setIcon] = useState<IconRef | null>(event?.icon ?? null);
  const [allDay, setAllDay] = useState(event?.allDay ?? true);
  const firstDay = event?.startDate ?? initialDate ?? today;
  const [startDate, setStartDate] = useState<LocalDate>(firstDay);
  const [startTime, setStartTime] = useState<LocalTime>(event?.startTime ?? DEFAULT_START_TIME);
  const initialEnd = event && !event.allDay && event.endTime !== null ? { date: event.endDate, time: event.endTime } : defaultEventEnd(firstDay, event?.startTime ?? DEFAULT_START_TIME);
  const [endDate, setEndDate] = useState<LocalDate>(initialEnd.date);
  const [endTime, setEndTime] = useState<LocalTime>(initialEnd.time);
  const [repeat, setRepeat] = useState<EventRepeat>(event?.repeat ?? 'once');
  const [offsets, setOffsets] = useState<readonly ReminderOffsetMin[]>(initialOffsets);
  const [spaceId, setSpaceId] = useState<SpaceId>(event?.spaceId ?? initialSpaceId);
  const [saving, setSaving] = useState(false);

  const valid = validateEventTitle(title).ok;
  const todayYear = parseLocalDate(today).year;

  // Focus dans le titre à l'ouverture : après le piège de focus de la feuille ou du panneau, qui prend le premier élément.
  useEffect(() => {
    if (!autoFocus) return undefined;
    const timer = window.setTimeout(() => titleRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [autoFocus]);

  function toggleAllDay(): void {
    if (allDay) {
      // Passage aux heures : début à 09:00, fin une heure plus tard (critère 3).
      const end = defaultEventEnd(startDate, startTime);
      setEndDate(end.date);
      setEndTime(end.time);
    }
    setAllDay(!allDay);
  }

  function changeStart(choice: DateChoice | null): void {
    if (choice === null || choice.date === null) return;
    const next = { date: choice.date, time: choice.time ?? startTime };
    const end = endAfterStartChange({ date: startDate, time: startTime }, next, { date: endDate, time: endTime });
    setStartDate(next.date);
    setStartTime(next.time);
    setEndDate(end.date);
    setEndTime(end.time);
  }

  function changeEnd(choice: DateChoice | null): void {
    if (choice === null || choice.date === null) return;
    const next = { date: choice.date, time: choice.time ?? endTime };
    // Fin >= début : une fin antérieure au début ramène la fin au début.
    if (eventDurationMin({ date: startDate, time: startTime }, next) < 0) {
      setEndDate(startDate);
      setEndTime(startTime);
      return;
    }
    setEndDate(next.date);
    setEndTime(next.time);
  }

  function fields(): EventFields {
    return {
      spaceId,
      title,
      startDate,
      startTime: allDay ? null : startTime,
      endDate: allDay ? startDate : endDate,
      endTime: allDay ? null : endTime,
      allDay,
      kind: event?.kind ?? 'event',
      repeat,
      important: event?.important ?? false,
      icon,
      birthYear: event?.birthYear ?? null,
    };
  }

  async function submit(submitEvent: FormEvent): Promise<void> {
    submitEvent.preventDefault();
    if (!valid || saving || !validateEvent(fields()).ok) return;
    setSaving(true);
    try {
      await onSubmit({ fields: fields(), reminderOffsets: offsets });
    } finally {
      setSaving(false);
    }
  }

  const heading = event ? t('events.sheet.editTitle') : t('events.sheet.newTitle');
  return (
    <form className="ct-event-form" noValidate onSubmit={(submitEvent) => void submit(submitEvent)} aria-labelledby={headingId}>
      <div className="ct-event-form__header">
        <h2 id={headingId} className="ct-event-form__heading">
          {heading}
        </h2>
        <button type="button" className="ct-event-form__close" aria-label={t('events.sheet.close')} onClick={onClose}>
          <Icon icon={X} />
        </button>
      </div>
      {onSegmentChange && <AddSegments value="event" onChange={(segment) => onSegmentChange(segment, title)} />}

      <TextField ref={titleRef} label={t('events.sheet.titleLabel')} placeholder={t('events.sheet.titleLabel')} value={title} onChange={setTitle} maxLength={EVENT_TITLE_MAX} className="ct-event-form__title" />
      <IconChooser value={icon} onChange={setIcon} />

      {allDay ? (
        <section className="ct-event-form__section" aria-label={t('events.sheet.date')}>
          <span className="ct-event-form__label">{t('events.sheet.date')}</span>
          {layout === 'mobile' ? (
            <EventDateWheels value={startDate} onChange={setStartDate} years={{ from: todayYear - 1, to: todayYear + 10 }} />
          ) : (
            <DatePicker value={{ date: startDate, time: null }} today={today} onChange={(choice) => choice?.date && setStartDate(choice.date)} allowSomeday={false} showTime={false} label={t('events.sheet.date')} />
          )}
        </section>
      ) : (
        <>
          <section className="ct-event-form__section" aria-label={t('events.sheet.start')}>
            <span className="ct-event-form__label">{t('events.sheet.start')}</span>
            <DatePicker value={{ date: startDate, time: startTime }} today={today} onChange={changeStart} allowSomeday={false} label={t('events.sheet.start')} />
          </section>
          <section className="ct-event-form__section" aria-label={t('events.sheet.end')}>
            <span className="ct-event-form__label">{t('events.sheet.end')}</span>
            <DatePicker value={{ date: endDate, time: endTime }} today={today} onChange={changeEnd} allowSomeday={false} label={t('events.sheet.end')} />
          </section>
        </>
      )}
      <Choice type="checkbox" checked={allDay} onChange={toggleAllDay}>
        {t('events.sheet.allDay')}
      </Choice>

      <div role="radiogroup" aria-label={t('events.sheet.repeat')} className="ct-event-form__section">
        <span className="ct-event-form__label">{t('events.sheet.repeat')}</span>
        <div className="ct-event-form__row ct-event-form__row--repeat">
          {REPEATS.map((option) => (
            <Choice key={option.value} type="radio" name={radioName} checked={repeat === option.value} onChange={() => setRepeat(option.value)}>
              {t(option.labelKey)}
            </Choice>
          ))}
        </div>
      </div>
      {event && repeat !== 'once' && <p className="ct-event-form__note">{t('events.sheet.seriesNote')}</p>}

      <div role="group" aria-label={t('events.sheet.reminder')} className="ct-event-form__section">
        <span className="ct-event-form__label">{t('events.sheet.reminder')}</span>
        <div className="ct-event-form__row">
          {EVENT_REMINDER_CHOICES.map((offset) => (
            <Choice key={offset} type="checkbox" checked={offsets.includes(offset)} onChange={() => setOffsets((current) => toggleEventReminderOffset(current, offset))}>
              {t(REMINDER_LABELS[offset] ?? 'events.sheet.reminder0')}
            </Choice>
          ))}
        </div>
      </div>

      <div className="ct-event-form__spaceRow">
        <span className="ct-event-form__spaceLabel">{t('events.sheet.space')}</span>
        <SpaceSegmented layout="compact" items={spaces} value={spaceId} onChange={setSpaceId} label={t('events.sheet.spaceLabel')} />
      </div>

      {errorMessage && (
        <p className="ct-event-form__error" role="alert">
          {errorMessage}
        </p>
      )}

      <div className="ct-event-form__spacer" />
      <div className="ct-event-form__actions">
        {onDelete && (
          <button type="button" className="ct-event-form__delete" onClick={onDelete}>
            <Icon icon={Trash2} size={20} />
            {t('events.sheet.delete')}
          </button>
        )}
        <Button type="submit" fullWidth disabled={!valid || saving}>
          {t('events.sheet.save')}
        </Button>
      </div>
    </form>
  );
}
