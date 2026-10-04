import type { Space } from '../../domain/model';
import { segmentsText, type SearchResult } from '../../domain/search';
import { t } from '../../i18n';
import { formatDayLabel, formatTime } from '../../i18n/format';

/** Un élément de la sous-ligne d'un résultat (séparés par « · » à l'écran, par des virgules pour les lecteurs d'écran). */
export interface SubtitlePart {
  readonly key: string;
  readonly text: string;
  /** Nom d'espace : écrit dans la couleur de l'espace. */
  readonly spaceColor?: string;
  /** Citation de la note ou de l'item : porte le surlignage. */
  readonly citation?: boolean;
}

/**
 * Sous-ligne d'un résultat (Recherche.html) : citation éventuelle (note ou item), date (ou « Un jour »), espace, état. Tâche :
 * « Mer. 23 sept. · Pro · à faire » ; checklist : date, avancement « 2/5 » ; événement : date, heure, « Mensuel » ; routine : espace,
 * état ; objectif : « Semaine du 21 sept. », espace, état.
 */
export function subtitleParts(result: SearchResult, spaces: readonly Pick<Space, 'id' | 'name' | 'color'>[]): SubtitlePart[] {
  const { hit } = result;
  const parts: SubtitlePart[] = [];
  if (result.citation) {
    const text = segmentsText(result.citation.segments);
    parts.push({ key: 'citation', text: t(result.citation.source === 'note' ? 'search.citeNote' : 'search.citeItem', { text }), citation: true });
  }
  if (hit.kind === 'task' && hit.someday) parts.push({ key: 'date', text: t('search.someday') });
  else if (hit.kind === 'goal' && hit.date) parts.push({ key: 'date', text: t('search.goalWeek', { date: formatDayLabel(hit.date) }) });
  else if (hit.date) parts.push({ key: 'date', text: `${formatDayLabel(hit.date)}${hit.time ? ` ${formatTime(hit.time)}` : ''}` });
  else if (hit.time) parts.push({ key: 'date', text: formatTime(hit.time) });
  if (hit.repeat === 'monthly') parts.push({ key: 'repeat', text: t('search.repeatMonthly') });
  if (hit.repeat === 'yearly') parts.push({ key: 'repeat', text: t('search.repeatYearly') });
  if (hit.kind === 'checklist' && hit.items.length > 0) parts.push({ key: 'progress', text: t('search.checklistProgress', { checked: hit.itemsChecked, total: hit.items.length }) });
  const space = spaces.find((candidate) => candidate.id === hit.spaceId);
  if (space) parts.push({ key: 'space', text: space.name, spaceColor: space.color });
  if (hit.status) parts.push({ key: 'status', text: t(`search.status.${hit.status}`) });
  return parts;
}

/** Nom accessible complet d'une ligne : « Tâche, Envoyer la facture, mer. 23 sept., Pro, à faire » (RC-03 critère 7). */
export function resultLabel(result: SearchResult, spaces: readonly Pick<Space, 'id' | 'name' | 'color'>[]): string {
  return [t(`search.kinds.${result.hit.kind}`), result.hit.title, ...subtitleParts(result, spaces).map((part) => part.text)].join(', ');
}
