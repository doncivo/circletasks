import { Clock } from 'lucide-react';
import { useMemo } from 'react';
import type { Routine, Space } from '../../domain/model';
import { mondayOf, weekCounter, weekRounds, type DateInterval } from '../../domain/routineSchedule';
import { computeStreaks } from '../../domain/routineStreaks';
import type { LocalDate } from '../../domain/types';
import { t } from '../../i18n';
import { formatTime } from '../../i18n/format';
import { formatStreak, scheduleShort, weekdayName } from '../../i18n/formatRoutine';
import { scheduleSentence } from '../../i18n/routinesRefonteText';
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
  /** Vue compacte (A-06, PC) : une ligne de titre, sans ligne d'informations. */
  readonly compact: boolean;
  readonly onEdit: () => void;
  /** Carte sélectionnée (PC : son rapport est dans le panneau de droite). */
  readonly selected: boolean;
  /** Ouvre le rapport de la routine : clic sur la carte (PC) ou toucher du corps de la carte (iPhone), hors ronds et « Modifier » (R-06, QB-06). */
  readonly onOpen: () => void;
  /** Valide ou rouvre un jour de la semaine (R-03) : ronds d'aujourd'hui et des jours passés seulement (QB-03). */
  readonly onToggleDay: (date: LocalDate) => void;
  /** N-FIX-04 : ligne « Rappels décalés … » (tous ou certains jours), null quand aucun rappel n'est décalé. */
  readonly quietLine?: string | null;
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Carte de routine. PC (PC-Routines.html) : icône, titre, « Modifier », sept ronds L M M J V S D (jours non prévus en pointillés),
 * compteur « faits / prévus » de la semaine à droite des ronds, ligne « heure · espace · fréquence ». iPhone (UI-REFONTE-05,
 * Routines-v2.html) : titre seul, « Modifier » au trait, les sept pastilles, puis « 22:30 · Perso · du lundi au vendredi · 3 sur 5 cette
 * semaine ». Tout est calculé à l'affichage par src/domain (aucune occurrence stockée).
 */
export function RoutineCard({ routine, spaces, done, pauses, today, layout, compact, selected, onEdit, onOpen, onToggleDay, quietLine = null }: RoutineCardProps) {
  const mobile = layout === 'mobile';
  const weekStart = mondayOf(today);
  const rounds = useMemo(() => weekRounds(routine, done, weekStart, today, pauses), [routine, done, weekStart, today, pauses]);
  const counter = useMemo(() => weekCounter(routine, done, weekStart, pauses), [routine, done, weekStart, pauses]);
  const streaks = useMemo(() => computeStreaks(routine, done, today, pauses), [routine, done, today, pauses]);
  const spaceName = spaces.find((space) => space.id === routine.spaceId)?.name ?? null;
  // « série 12 jours » seulement si elle est en cours (R-04 critère 7).
  const streakText = streaks.current > 0 ? t('routines.streak.info', { value: formatStreak(streaks.current, streaks.unit) }) : null;
  const info = [routine.time ? formatTime(routine.time) : null, spaceName, mobile ? scheduleSentence(routine) : scheduleShort(routine), routine.paused ? t('routines.paused') : null, streakText].filter((part): part is string => Boolean(part));
  const color = routine.icon ? resolveIconRefColor(routine.icon) : undefined;
  const counterLabel = t('routines.counterLabel', { done: counter.done, planned: counter.planned });
  const separator = t('routines.infoSeparator');

  return (
    <article
      className="ct-routine-card"
      data-layout={layout}
      data-compact={compact}
      data-paused={routine.paused}
      data-selected={selected}
      onClick={(event) => {
        // Corps de la carte seulement : les ronds et « Modifier » ont leur propre action (R-06 critère 6).
        if (!(event.target as HTMLElement).closest('button')) onOpen();
      }}
    >
      <div className="ct-routine-card__head">
        {!mobile && routine.icon && <IconView icon={routine.icon} color={color ?? 'currentColor'} size={28} />}
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
        {!mobile && (
          <span className="ct-routine-card__counter" role="img" aria-label={counterLabel}>
            {counter.done}/{counter.planned}
          </span>
        )}
      </div>
      {/* iPhone (UI-REFONTE-05) : toujours la ligne d'informations, le compteur en phrase à sa fin ; PC : masquée en vue compacte. */}
      {mobile ? (
        <p className="ct-routine-card__info">
          <span>
            {info.length > 0 && `${info.join(separator)}${separator}`}
            <span className="ct-routine-card__counter" aria-label={counterLabel}>
              {counterLabel}
            </span>
          </span>
        </p>
      ) : (
        !compact &&
        info.length > 0 && (
          <p className="ct-routine-card__info">
            {routine.time && <Clock size={18} strokeWidth={1.8} aria-hidden="true" className="ct-routine-card__clock" />}
            <span>{info.join(separator)}</span>
          </p>
        )
      )}
      {/* N-FIX-04 : rappels décalés par les plages silencieuses de l'espace (tous, ou seulement certains jours), toujours dit. */}
      {quietLine !== null && (
        <p className="ct-routine-card__info ct-routine-card__quiet" role="note">
          <span>{quietLine}</span>
        </p>
      )}
    </article>
  );
}
