import type { EventListEntry } from '../../domain/eventList';
import { parseLocalDate } from '../../domain/localDate';
import type { LocalDate } from '../../domain/types';
import { getLocale } from '../../i18n';
import { entrySubtitle } from './eventRowText';


export interface EventRowProps {
  readonly entry: EventListEntry;
  readonly today: LocalDate;
  readonly past: boolean;
  /** Nom de l'espace écrit en fin de sous-ligne (filtre « Tout »). */
  readonly spaceName: string | null;
  readonly tag: { readonly label: string; readonly kind: 'today' | 'countdown' | 'birthday' | 'holidayFr' | 'holidayTn'; readonly spoken?: string } | null;
  readonly selected?: boolean;
  /** Ouvre la fiche (événement local) ; absent : ligne en lecture seule. */
  readonly onOpen?: () => void;
  /** Ligne d'un jour férié ou d'un événement externe : sous-ligne imposée. */
  readonly subtitle?: string;
}

function weekdayShort(date: LocalDate): string {
  const { year, month, day } = parseLocalDate(date);
  return new Intl.DateTimeFormat(getLocale() === 'en' ? 'en-US' : 'fr-FR', { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * Ligne de la liste Événements (Evenements.html) : jour (Fraunces) et jour de la semaine, titre, sous-ligne, étiquette. Un événement
 * local est un bouton qui ouvre sa fiche ; un événement externe ou un jour férié est en lecture seule.
 */
export function EventRow({ entry, today, past, spaceName, tag, selected, onOpen, subtitle }: EventRowProps) {
  const { day } = parseLocalDate(entry.date);
  const content = (
    <>
      <span className="ct-event-row__date" aria-hidden="true">
        <span className="ct-event-row__day">{day}</span>
        <span className="ct-event-row__weekday">{weekdayShort(entry.date)}</span>
      </span>
      <span className="ct-event-row__text">
        <span className="ct-event-row__title">{entry.title}</span>
        <span className="ct-event-row__subtitle">{subtitle ?? entrySubtitle(entry, { spaceName })}</span>
      </span>
      {tag && (
        <span className="ct-event-row__tag" data-tag={tag.kind}>
          <span aria-hidden={tag.spoken ? 'true' : undefined}>{tag.label}</span>
          {tag.spoken && <span className="ct-visually-hidden">{tag.spoken}</span>}
        </span>
      )}
    </>
  );
  const props = { className: 'ct-event-row', 'data-source': entry.source, 'data-past': past || undefined, 'data-today': (entry.date <= today && entry.endDate >= today) || undefined, 'data-selected': selected || undefined, 'data-date': entry.date };
  return (
    <li className="ct-event-row__item">
      {onOpen ? (
        <button type="button" {...props} onClick={onOpen}>
          {content}
        </button>
      ) : (
        <div {...props}>{content}</div>
      )}
    </li>
  );
}
