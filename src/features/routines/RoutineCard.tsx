import { Clock } from 'lucide-react';
import { useMemo } from 'react';
import type { Routine, Space } from '../../domain/model';
import { mondayOf, weekCounter, weekRounds } from '../../domain/routineSchedule';
import type { LocalDate } from '../../domain/types';
import { t } from '../../i18n';
import { scheduleShort, weekdayName } from '../../i18n/formatRoutine';
import { IconView, resolveIconRefColor, type Layout } from '../../ui';
import './RoutineCard.css';

export interface RoutineCardProps {
  readonly routine: Routine;
  readonly spaces: readonly Space[];
  /** Dates validées de la routine (historique complet). */
  readonly done: ReadonlySet<LocalDate>;
  readonly today: LocalDate;
  readonly layout: Layout;
  /** Vue compacte (A-06) : une ligne de titre, sans ligne d'informations. */
  readonly compact: boolean;
  readonly onEdit: () => void;
  /** Valide ou rouvre un jour de la semaine (R-03) : ronds d'aujourd'hui et des jours passés seulement (QB-03). */
  readonly onToggleDay: (date: LocalDate) => void;
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Carte de routine (Routines.html, PC-Routines.html) : icône, titre, bouton « Éditer », sept ronds L M M J V S D (jours non
 * prévus en pointillés), compteur « faits / prévus » de la semaine en cours, ligne « heure · espace · fréquence ». Tout est calculé
 * à l'affichage par src/domain (aucune occurrence stockée).
 */
export function RoutineCard({ routine, spaces, done, today, layout, compact, onEdit, onToggleDay }: RoutineCardProps) {
  const weekStart = mondayOf(today);
  const rounds = useMemo(() => weekRounds(routine, done, weekStart, today), [routine, done, weekStart, today]);
  const counter = useMemo(() => weekCounter(routine, done, weekStart), [routine, done, weekStart]);
  const spaceName = spaces.find((space) => space.id === routine.spaceId)?.name ?? null;
  const info = [routine.time, spaceName, scheduleShort(routine)].filter((part): part is string => Boolean(part));
  const color = routine.icon ? resolveIconRefColor(routine.icon) : undefined;

  return (
    <article className="ct-routine-card" data-layout={layout} data-compact={compact} data-paused={routine.paused}>
      <div className="ct-routine-card__head">
        {routine.icon && <IconView icon={routine.icon} color={color ?? 'currentColor'} size={layout === 'pc' ? 28 : 30} />}
        <h2 className="ct-routine-card__title">{routine.title}</h2>
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
        <span className="ct-routine-card__counter" aria-label={t('routines.counterLabel', { done: counter.done, planned: counter.planned })}>
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
