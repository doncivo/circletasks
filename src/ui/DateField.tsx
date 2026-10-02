import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { addMonths, monthGrid, monthOf, moveCalendarFocus, type CalendarMonth } from '../domain/calendarMonth';
import { parseFrenchDate, parseTimeInput, type DateChoice } from '../domain/dateInput';
import { addDays } from '../domain/localDate';
import { nextWeekFrom } from '../domain/taskPostpone';
import type { LocalDate } from '../domain/types';
import { t } from '../i18n';
import { formatDayAria, formatDayFull, formatDayLabel, formatMonthTitle, weekdayInitials, weekdayNamesLong } from '../i18n/format';
import { Icon } from './Icon';
import './DateField.css';

export interface DateEditorProps {
  /** Choix courant ; null : rien de choisi (champ vide). */
  value: DateChoice | null;
  /** Aujourd'hui, fourni par l'appelant (horloge du conteneur). */
  today: LocalDate;
  /**
   * 'popover' : champ « Date » seul, la fenêtre « Choisir une date » s'ouvre dessous (saisie, détail) ;
   * 'inline' : champ et fenêtre affichés ensemble (fenêtre « Choisir une date » du report, de la duplication).
   */
  mode: 'popover' | 'inline';
  allowSomeday?: boolean;
  /** Ligne « Heure » du calendrier (défaut : oui) ; sans elle, seule la date est choisie. */
  showTime?: boolean;
  /**
   * Un clic sur une puce ou sur un jour valide aussitôt (champ) ; sinon il fait seulement le choix
   * (fenêtre avec bouton de validation).
   */
  commitOnPick?: boolean;
  /** Entrée ou perte de focus avec une saisie valide, clic validant : `null` = champ vidé (si `allowEmpty`). */
  onCommit: (choice: DateChoice | null) => void;
  /** Brouillon courant, null tant qu'il n'est pas valide (bouton « Valider » de la fenêtre). */
  onDraftChange?: (choice: DateChoice | null) => void;
  /** Un champ vidé est un choix valide (saisie : retour au jour affiché). */
  allowEmpty?: boolean;
  /** Échap (popover) : ferme sans rien changer. */
  onCancel?: () => void;
  /** Ouvre la fenêtre au-dessus du champ (champ en bas d'écran). */
  placement?: 'below' | 'above' | 'auto';
  /** Focus dans le champ au montage (fenêtre). */
  autoFocus?: boolean;
  /** Nom accessible du champ (défaut : « Date »). */
  label?: string;
  className?: string;
}

/** Hauteur approximative de la fenêtre « Choisir une date » (px). */
const POPOVER_HEIGHT = 470;

const choiceKey = (choice: DateChoice | null): string => (choice === null ? '' : `${choice.date ?? 'x'}|${choice.time ?? ''}`);

/** Texte du champ pour un choix : « Aujourd'hui », « Demain », « ven. 25 sept. 10:00 », « Un jour » ; relisible par `parseFrenchDate`. */
function fieldText(choice: DateChoice | null, today: LocalDate): string {
  if (choice === null) return '';
  if (choice.date === null) return t('datePicker.someday');
  const [year] = choice.date.split('-');
  const sameYear = year === today.slice(0, 4);
  let day: string;
  if (choice.date === today) day = t('datePicker.today');
  else if (choice.date === addDays(today, 1)) day = t('datePicker.tomorrow');
  else if (sameYear && choice.date > today) day = formatDayLabel(choice.date);
  else day = `${formatDayLabel(choice.date).replace(/^\S+\s/, '')} ${year}`; // « 25 sept. 2030 » : l'année évite l'ambiguïté de la saisie
  return choice.time ? `${day} ${choice.time}` : day;
}

function summary(choice: DateChoice): string {
  if (choice.date === null) return t('datePicker.somedaySummary');
  return choice.time
    ? t('datePicker.understoodAt', { day: formatDayFull(choice.date), time: choice.time })
    : formatDayFull(choice.date);
}

/**
 * Sélecteur de date PC (T-14, PC-Date.html) : champ « Date » à saisie libre (« demain », « lun. 10h »,
 * « 25/09 », « dans 3 jours »…) avec bandeau « Compris : vendredi 25 sept. à 10:00 » en direct, puces
 * « Aujourd'hui », « Demain », « Lundi prochain », « Un jour », mini-calendrier (lundi en premier, flèches du
 * clavier, mois précédent / suivant) et ligne « Heure » (« 10 », « 10h », « 10:00 », « 1030 » ; vide = sans heure).
 * Entrée valide, Échap ferme sans rien changer ; une saisie non comprise affiche « Date non comprise » et
 * Entrée ne valide pas.
 */
export function DateEditor({
  value,
  today,
  mode,
  allowSomeday = true,
  showTime = true,
  commitOnPick = false,
  onCommit,
  onDraftChange,
  allowEmpty = false,
  onCancel,
  placement = 'auto',
  autoFocus = false,
  label,
  className,
}: DateEditorProps) {
  const ids = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(mode === 'inline');
  const [text, setText] = useState(() => fieldText(value, today));
  const [draft, setDraft] = useState<DateChoice | null>(value);
  const [textError, setTextError] = useState(false);
  const [timeText, setTimeText] = useState(value?.time ?? '');
  const [timeError, setTimeError] = useState(false);
  const [month, setMonth] = useState<CalendarMonth>(() => monthOf(value?.date ?? today));
  const [focusDate, setFocusDate] = useState<LocalDate>(value?.date ?? today);
  const focusAfterRender = useRef(false);
  const [autoAbove, setAutoAbove] = useState(false);

  // Valeur modifiée de l'extérieur (formulaire remis à zéro, choix appliqué ailleurs) : le champ la suit.
  const [seen, setSeen] = useState(choiceKey(value));
  if (choiceKey(value) !== seen) {
    setSeen(choiceKey(value));
    setText(fieldText(value, today));
    setDraft(value);
    setTextError(false);
    setTimeError(false);
    setTimeText(value?.time ?? '');
  }

  const invalid = textError || timeError;
  const someday = draft !== null && draft.date === null;
  const selectedDate = draft?.date ?? null;

  function publish(next: DateChoice | null, hasError: boolean): void {
    setDraft(next);
    onDraftChange?.(hasError ? null : next);
  }

  function showDate(date: LocalDate | null): void {
    if (date === null) return;
    setMonth(monthOf(date));
    setFocusDate(date);
  }

  function handleTextChange(next: string): void {
    setText(next);
    if (mode === 'popover') setOpen(true);
    const result = parseFrenchDate(next, today);
    if (result.ok) {
      setTextError(false);
      setTimeError(false);
      setTimeText(result.value.time ?? '');
      publish(result.value, false);
      showDate(result.value.date);
    } else if (result.error === 'empty') {
      setTextError(false);
      setTimeError(false);
      setTimeText('');
      publish(null, false);
    } else {
      setTextError(true);
      publish(null, true);
    }
  }

  function applyChoice(choice: DateChoice): void {
    setText(fieldText(choice, today));
    setTimeText(choice.time ?? '');
    setTextError(false);
    setTimeError(false);
    publish(choice, false);
    showDate(choice.date);
  }

  function pick(choice: DateChoice): void {
    applyChoice(choice);
    if (commitOnPick) {
      onCommit(choice);
      if (mode === 'popover') {
        setOpen(false);
        inputRef.current?.focus();
      }
    }
  }

  function handleTimeChange(next: string): void {
    setTimeText(next);
    const result = parseTimeInput(next);
    if (!result.ok) {
      setTimeError(true);
      publish(null, true);
      return;
    }
    setTimeError(false);
    const choice: DateChoice = { date: draft?.date ?? today, time: result.value };
    setText(fieldText(choice, today));
    setTextError(false);
    publish(choice, false);
    showDate(choice.date);
  }

  /** Entrée : valide le choix courant s'il est compris ; ne soumet jamais un formulaire parent. */
  function handleEnter(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (invalid) return;
    if (draft === null && !allowEmpty) return;
    onCommit(draft);
    if (mode === 'popover') setOpen(false);
  }

  function revert(): void {
    setText(fieldText(value, today));
    setDraft(value);
    setTextError(false);
    setTimeError(false);
    setTimeText(value?.time ?? '');
    onDraftChange?.(value);
    if (value?.date) showDate(value.date);
  }

  function handleRootKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && onCancel && (mode === 'inline' || open)) {
      event.preventDefault();
      event.stopPropagation();
      revert();
      setOpen(false);
      onCancel();
    } else if (event.key === 'ArrowDown' && mode === 'popover' && !open && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      setOpen(true);
    }
  }

  /** Focus sorti du champ et de sa fenêtre : valide une saisie comprise, sinon revient à la valeur. */
  function handleBlur(event: FocusEvent): void {
    if (mode !== 'popover') return;
    const next = event.relatedTarget;
    if (next instanceof Node && wrapperRef.current?.contains(next)) return;
    if (!open && !invalid && choiceKey(draft) === choiceKey(value)) return;
    setOpen(false);
    if (invalid || (draft === null && !allowEmpty)) revert();
    else if (choiceKey(draft) !== choiceKey(value)) onCommit(draft);
  }

  // « auto » : la fenêtre s'ouvre du côté où il y a le plus de place (champ en bas de page : au-dessus).
  useLayoutEffect(() => {
    if (!open || mode !== 'popover' || placement !== 'auto') return;
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAutoAbove(window.innerHeight - rect.bottom < POPOVER_HEIGHT && rect.top > window.innerHeight - rect.bottom);
  }, [open, mode, placement]);

  // Déplacement du focus dans la grille après un changement de case (le bouton n'existe qu'après le rendu).
  useEffect(() => {
    if (!focusAfterRender.current) return;
    focusAfterRender.current = false;
    wrapperRef.current?.querySelector<HTMLButtonElement>('[data-focus-day="true"]')?.focus();
  });

  function handleGridKeyDown(event: KeyboardEvent): void {
    const next = moveCalendarFocus(focusDate, event.key);
    if (!next) return;
    event.preventDefault();
    setFocusDate(next);
    const nextMonth = monthOf(next);
    if (nextMonth.year !== month.year || nextMonth.month !== month.month) setMonth(nextMonth);
    focusAfterRender.current = true;
  }

  const cells = monthGrid(month.year, month.month);
  const firstOfMonth = cells.find((cell): cell is LocalDate => cell !== null);
  const focusInMonth = cells.includes(focusDate);
  const tabbable = focusInMonth ? focusDate : firstOfMonth;
  const nextMonday = nextWeekFrom(today);
  const tomorrow = addDays(today, 1);
  const keepTime = draft?.time ?? null;
  const initials = weekdayInitials();
  const weekdayNames = weekdayNamesLong();
  const weeks = Array.from({ length: Math.ceil(cells.length / 7) }, (_, w) => Array.from({ length: 7 }, (_, i) => cells[w * 7 + i] ?? null));

  const panel = (
    <div
      className="ct-date-editor__panel"
      // Un clic dans la fenêtre ne retire pas le focus du champ (sauf pour le champ « Heure »).
      onMouseDown={(event) => {
        if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
      }}
    >
      <div className="ct-date-editor__banner" aria-live="polite" data-error={invalid ? 'true' : undefined}>
        {invalid ? (
          <span>{textError ? t('datePicker.notUnderstood') : t('datePicker.timeNotUnderstood')}</span>
        ) : draft ? (
          <span>{t('datePicker.understoodLabel')} <b>{summary(draft)}</b></span>
        ) : null}
      </div>
      <div className="ct-date-editor__chips">
        <button type="button" className="ct-date-editor__chip" aria-pressed={selectedDate === today} onClick={() => pick({ date: today, time: keepTime })}>
          {t('datePicker.today')}
        </button>
        <button type="button" className="ct-date-editor__chip" aria-pressed={selectedDate === tomorrow} onClick={() => pick({ date: tomorrow, time: keepTime })}>
          {t('datePicker.tomorrow')}
        </button>
        <button type="button" className="ct-date-editor__chip" aria-pressed={selectedDate === nextMonday} onClick={() => pick({ date: nextMonday, time: keepTime })}>
          {t('datePicker.nextMonday')}
        </button>
        {allowSomeday && (
          <button type="button" className="ct-date-editor__chip" aria-pressed={someday} onClick={() => pick({ date: null, time: null })}>
            {t('datePicker.someday')}
          </button>
        )}
      </div>
      <div className="ct-date-editor__monthRow">
        <span className="ct-date-editor__monthTitle" id={`${ids}-month`} aria-live="polite">
          {formatMonthTitle(month.year, month.month)}
        </span>
        <div className="ct-date-editor__monthNav">
          <button type="button" className="ct-date-editor__navButton" aria-label={t('datePicker.previousMonth')} onClick={() => setMonth(addMonths(month, -1))}>
            <Icon icon={ChevronLeft} size={18} />
          </button>
          <button type="button" className="ct-date-editor__navButton" aria-label={t('datePicker.nextMonth')} onClick={() => setMonth(addMonths(month, 1))}>
            <Icon icon={ChevronRight} size={18} />
          </button>
        </div>
      </div>
      <div className="ct-date-editor__grid" role="grid" aria-labelledby={`${ids}-month`} onKeyDown={handleGridKeyDown}>
        <div role="row" className="ct-date-editor__row">
          {initials.map((initial, i) => (
            <span key={`h${i}`} role="columnheader" className="ct-date-editor__weekday" aria-label={weekdayNames[i]}>
              {initial}
            </span>
          ))}
        </div>
        {weeks.map((week, w) => (
          <div key={w} role="row" className="ct-date-editor__row">
            {week.map((cell, i) => {
              if (cell === null) return <span key={`e${i}`} role="gridcell" aria-hidden="true" />;
              const isToday = cell === today;
              const isChosen = cell === selectedDate;
              const suffix = [isToday ? t('datePicker.todaySuffix') : null, isChosen ? t('datePicker.chosenSuffix') : null].filter(Boolean).join(', ');
              return (
                <span key={cell} role="gridcell" aria-selected={isChosen}>
                  <button
                    type="button"
                    className="ct-date-editor__day"
                    data-today={isToday ? 'true' : undefined}
                    data-chosen={isChosen ? 'true' : undefined}
                    data-focus-day={cell === tabbable ? 'true' : undefined}
                    tabIndex={cell === tabbable ? 0 : -1}
                    aria-label={suffix ? `${formatDayAria(cell)}, ${suffix}` : formatDayAria(cell)}
                    aria-current={isToday ? 'date' : undefined}
                    onClick={() => pick({ date: cell, time: keepTime })}
                  >
                    {Number(cell.slice(8))}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
      {showTime && (
        <div className="ct-date-editor__timeRow">
          <label className="ct-date-editor__timeLabel" htmlFor={`${ids}-time`}>
            {t('datePicker.timeLabel')}
          </label>
          <div className="ct-date-editor__timeControl">
            <input
              id={`${ids}-time`}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              className="ct-date-editor__timeInput"
              placeholder={t('datePicker.timePlaceholder')}
              value={timeText}
              disabled={someday}
              aria-invalid={timeError || undefined}
              onChange={(event) => handleTimeChange(event.target.value)}
              onKeyDown={handleEnter}
            />
            <span className="ct-date-editor__hint">{t('datePicker.hint')}</span>
          </div>
        </div>
      )}
      {!showTime && <p className="ct-date-editor__hint ct-date-editor__hint--alone">{t('datePicker.hint')}</p>}
    </div>
  );

  return (
    <div
      ref={wrapperRef}
      className={['ct-date-editor', `ct-date-editor--${mode}`, className].filter(Boolean).join(' ')}
      onKeyDown={handleRootKeyDown}
      onBlur={handleBlur}
    >
      <div className="ct-date-editor__field" data-invalid={textError ? 'true' : undefined}>
        <Icon icon={CalendarDays} size={18} />
        <input
          ref={inputRef}
          type="text"
          role={mode === 'popover' ? 'combobox' : undefined}
          aria-label={label ?? t('datePicker.dateLabel')}
          aria-expanded={mode === 'popover' ? open : undefined}
          aria-haspopup={mode === 'popover' ? 'dialog' : undefined}
          aria-controls={mode === 'popover' && open ? `${ids}-panel` : undefined}
          aria-invalid={textError || undefined}
          autoComplete="off"
          autoFocus={autoFocus}
          className="ct-date-editor__input"
          placeholder={t('datePicker.placeholder')}
          value={text}
          onChange={(event) => handleTextChange(event.target.value)}
          onClick={() => mode === 'popover' && setOpen(true)}
          onKeyDown={handleEnter}
        />
        {mode === 'popover' && (
          <button
            type="button"
            className="ct-date-editor__toggle"
            aria-label={t('datePicker.openCalendar')}
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <Icon icon={ChevronDown} size={16} />
          </button>
        )}
      </div>
      {open &&
        (mode === 'popover' ? (
          <div
            id={`${ids}-panel`}
            role="dialog"
            aria-label={t('datePicker.dialogLabel')}
            className={`ct-date-editor__popover ct-date-editor__popover--${placement === 'auto' ? (autoAbove ? 'above' : 'below') : placement}`}
          >
            {panel}
          </div>
        ) : (
          panel
        ))}
    </div>
  );
}

export type DateFieldProps = Omit<DateEditorProps, 'mode' | 'commitOnPick' | 'onCommit' | 'onCancel' | 'onDraftChange'> & {
  /** Choix validé (Entrée, clic sur une puce ou un jour, perte de focus avec une saisie comprise) ; null : champ vidé. */
  onChange: (choice: DateChoice | null) => void;
};

/**
 * Champ « Date » PC avec fenêtre « Choisir une date » (T-14) : voir `DateEditor`. S'ouvre au clic, à la
 * frappe, à la flèche bas ou par le bouton calendrier ; se ferme à la validation, par Échap (sans rien changer)
 * ou quand le focus le quitte.
 */
export function DateField({ onChange, allowEmpty = true, ...rest }: DateFieldProps) {
  return <DateEditor {...rest} mode="popover" commitOnPick allowEmpty={allowEmpty} onCommit={onChange} onCancel={() => undefined} />;
}
