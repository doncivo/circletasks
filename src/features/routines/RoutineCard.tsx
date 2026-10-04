import { Clock } from 'lucide-react';
import { useMemo } from 'react';
import type { Routine, Space } from '../../domain/model';
import { mondayOf, weekCounter, weekRounds, type DateInterval } from '../../domain/routineSchedule';
import { computeStreaks } from '../../domain/routineStreaks';
import type { LocalDate } from '../../domain/types';
import { t } from '../../i18n';
import { formatTime } from '../../i18n/format';
import { formatStreak, scheduleShort, weekdayName } from '../../i18n/formatRoutine';
import { IconView, resolveIconRefColor, type Layout } from '../../ui';
import './RoutineCard.css';

export interface RoutineCardProps {
  readonly routine: Routine;
  readonly spaces: readonly Space[];
  /** Dates validées de la routine (historique complet). */
  readonly done: ReadonlySet<LocalDate>;
  /** Périodes de pause de la routine : leurs jours ne sont pas prévus. */
  readonly pauses: readonly DateInterval[];
  readonly today: LocalDate;
  readonly layout: Layout;
  /** Vue compacte (A-06) : une ligne de titre, sans ligne d'informations. */
  readonly compact: boolean;
  readonly onEdit: () => void;
  /** Carte sélectionnée (PC : son rapport est dans le panneau de droite). */
  readonly selected: boolean;
  /** Ouvre le rapport de la routine : clic sur la carte (PC) ou toucher du corps de la carte (iPhone), hors ronds et « Éditer » (R-06, QB-06). */
  readonly onOpen: () => void;
  /** Valide ou rouvre un jour de la semaine (R-03) : ronds d'aujourd'hui et des jours passés seulement (QB-03). */
  readonly onToggleDay: (date: LocalDate) => void;
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Carte de routine (Routines.html, PC-Routines.html) : icône, titre, bouton « Éditer », sept ronds L M M J V S D (jours non
 * prévus en pointillés), compteur « faits / prévus » de la semaine en cours, ligne « heure · espace · fréquence ». Tout est calculé
 * à l'affichage par src/domain (aucune occurrence stockée).
 */
export function RoutineCard({ routine, spaces, done, pauses, today, layout, compact, selected, onEdit, onOpen, onToggleDay }: RoutineCardProps) {
  const weekStart = mondayOf(today);
  const rounds = useMemo(() => weekRounds(routine, done, weekStart, today, pauses), [routine, done, weekStart, today, pauses]);
  const counter = useMemo(() => weekCounter(routine, done, weekStart, pauses), [routine, done, weekStart, pauses]);
  const streaks = useMemo(() => computeStreaks(routine, done, today, pauses), [routine, done, today, pauses]);
  const spaceName = spaces.find((space) => space.id === routine.spaceId)?.name ?? null;
  // « série 12 jours » seulement si elle est en cours (R-04 critère 7).
  const streakText = streaks.current > 0 ? t('routines.streak.info', { value: formatStreak(streaks.current, streaks.unit) }) : null;
  const info = [routine.time ? formatTime(routine.time) : null, spaceName, scheduleShort(routine), routine.paused ? t('routines.paused') : null, streakText].filter((part): part is string => Boolean(part));
  const color = routine.icon ? resolveIconRefColor(routine.icon) : undefined;

  return (
    <article
      className="ct-routine-card"
      data-layout={layout}
      data-compact={compact}
      data-paused={routine.paused}
      data-selected={selected}
      onClick={(event) => {
        // Corps de la carte seulement : les ronds et « Éditer » ont leur propre action (R-06 critère 6).
        if (!(event.target as HTMLElement).closest('button')) onOpen();
      }}
    >
      <div className="ct-routine-card__head">
        {routine.icon && <IconView icon={routine.icon} color={color ?? 'currentColor'} size={layout === 'pc' ? 28 : 30} />}
        <h2 className="ct-routine-card__title">
          <button type="button" className="ct-routine-card__open" aria-haspopup="dialog" onClick={onOpen}>
            {routine.title}
          </button>
        </h2>
        <button type="button" className="ct-routine-card__edit" aria-label={t('routines.editLabel', { title: routine.title })} onClick={onEdit}>
          {t('routines.edit')}
        </button>
      </div>
      <div className="ct-routine-card__week" role="group" aria-label={routine.title}>
        {rounds.map((round) => {
          const day = capitalize(weekdayName(round.weekday, 'long'));
          const label = round.done ? t('routines.roundDone', { day }) : round.planned ? day : t('routines.roundNotPlanned', { day });
          return (
            <button
              key={round.date}
              type="button"
              role="checkbox"
              aria-checked={round.done}
              aria-disabled={!round.toggleable}
              aria-label={label}
              data-state={round.done ? 'done' : round.planned ? 'planned' : 'off'}
              data-date={round.date}
              className="ct-routine-card__round"
              onClick={() => {
                if (round.toggleable) onToggleDay(round.date);
              }}
            >
              {day.charAt(0)}
            </button>
          );
        })}
        <span className="ct-routine-card__counter" role="img" aria-label={t('routines.counterLabel', { done: counter.done, planned: counter.planned })}>
          {counter.done}/{counter.planned}
        </span>
      </div>
      {!compact && info.length > 0 && (
        <p className="ct-routine-card__info">
          {layout === 'mobile' && routine.time && <Clock size={18} strokeWidth={1.8} aria-hidden="true" />}
          <span>{info.join(t('routines.infoSeparator'))}</span>
        </p>
      )}
    </article>
  );
}
