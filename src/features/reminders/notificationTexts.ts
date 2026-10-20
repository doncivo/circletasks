import type { CalendarEvent, Routine, Space, Task } from '../../domain/model';
import { bodyParts, type ReminderBodyItem } from '../../domain/notificationBody';
import type { NotificationPlan, PlannedItem } from '../../domain/notificationPlan';
import type { Recap } from '../../domain/recap';
import { t } from '../../i18n';
import { formatDayLabel, formatTime } from '../../i18n/format';
import { tNotificationBody } from '../../i18n/notificationBodyText';
import type { NotificationRequest } from '../../platform/notifications';
import { formatRecapTitle } from './recapText';

/**
 * Textes des notifications (N-01, ADR 0012 avenant N1.3) : tout vient de `src/i18n` (espace `notifications`). Les titres et corps ne vont
 * JAMAIS dans le journal technique (codes et nombres seulement). Un titre vide est refusé par `replace` : repli sur « Sans titre ».
 */

/** Lignes du corps d'un récapitulatif avant « et N autres » (corps limité en longueur pour iOS, N-04 critère 11). */
export const RECAP_BODY_LINES = 5;

/** Corps d'un récapitulatif du jour : les 5 premières lignes (heure et titre), puis « et {n} autres ». */
export function recapBody(content: Recap): string {
  const lines = content.lines.slice(0, RECAP_BODY_LINES).map((line) => (line.time === null ? line.title : `${formatTime(line.time)} ${line.title}`));
  if (content.lines.length > RECAP_BODY_LINES) lines.push(t('notifications.recap.more', { n: content.lines.length - RECAP_BODY_LINES }));
  return lines.join('\n');
}

export interface TitleLookup {
  readonly tasks: ReadonlyMap<string, Pick<Task, 'title'> & Partial<Pick<Task, 'date' | 'time' | 'spaceId'>>>;
  readonly routines: ReadonlyMap<string, Pick<Routine, 'title'> & Partial<Pick<Routine, 'time' | 'spaceId'>>>;
  readonly events: ReadonlyMap<string, Pick<CalendarEvent, 'title'> & Partial<Pick<CalendarEvent, 'startDate' | 'startTime' | 'allDay' | 'spaceId'>>>;
  readonly spaces?: ReadonlyMap<string, Pick<Space, 'name'>>;
}

/** Constructeur unique des quatre natures de rappels. */
export function notificationBody(item: ReminderBodyItem, lookup: TitleLookup): string {
  const kind = item.kind === 'snooze' ? item.originKind : item.kind;
  const task = lookup.tasks.get(item.targetId);
  const routine = lookup.routines.get(item.targetId);
  const event = lookup.events.get(item.targetId);
  const parts = bodyParts(item, {
    date: kind === 'task' ? task?.date ?? null : kind === 'event' ? event?.startDate ?? null : item.occurrenceDate,
    time: kind === 'task' ? task?.time ?? null : kind === 'event' ? event?.startTime ?? null : routine?.time ?? null,
    allDay: kind === 'event' && event?.allDay === true,
  });
  const clock = parts.allDay ? t('events.allDay') : parts.time === null ? '' : formatTime(parts.time);
  const when = parts.day === null ? clock : clock === '' ? formatDayLabel(parts.day) : tNotificationBody('dayTime', { day: formatDayLabel(parts.day), time: clock });
  if (parts.snoozed) return tNotificationBody('snoozed', { when });
  const space = lookup.spaces?.get(item.kind === 'snooze' ? '' : item.spaceId)?.name;
  const line = space === undefined || space.trim() === '' ? when : tNotificationBody('line', { when, space });
  return parts.shifted ? tNotificationBody('shifted', { line }) : line;
}

const titled = (title: string | undefined): string => (title === undefined || title.trim() === '' ? t('notifications.untitled') : title);

/** Requête de notification d'un élément du plan. */
export function requestFor(item: PlannedItem, lookup: TitleLookup): NotificationRequest {
  switch (item.kind) {
    // N-03 : chaque rappel porte la catégorie de sa nature (boutons « Fait » / « +15 min » ; l'événement n'a que « +15 min »).
    case 'task':
      return { id: item.id, fireAt: item.fireAt, kind: 'task', category: 'task', title: titled(lookup.tasks.get(item.targetId)?.title), body: notificationBody(item, lookup) };
    case 'routine':
      return { id: item.id, fireAt: item.fireAt, kind: 'routine', category: 'routine', title: titled(lookup.routines.get(item.targetId)?.title), body: notificationBody(item, lookup) };
    case 'event':
      return { id: item.id, fireAt: item.fireAt, kind: 'event', category: 'event', title: titled(lookup.events.get(item.targetId)?.title), body: notificationBody(item, lookup) };
    case 'snooze': {
      // Répétition : heure de la cible, sans espace ni mention de décalage.
      const title = item.originKind === 'task' ? lookup.tasks.get(item.targetId)?.title : item.originKind === 'routine' ? lookup.routines.get(item.targetId)?.title : lookup.events.get(item.targetId)?.title;
      return { id: item.id, fireAt: item.fireAt, kind: 'snooze', category: item.originKind, title: titled(title), body: notificationBody(item, lookup) };
    }
    case 'recap':
      // Jour courant : le contenu de buildRecap ; un autre jour : le texte générique qui invite à ouvrir l'app (N-07 critère 3).
      return item.content === null
        ? { id: item.id, fireAt: item.fireAt, kind: 'recap', title: t(item.recapKind === 'morning' ? 'notifications.recap.morningTitle' : 'notifications.recap.eveningTitle'), body: t('notifications.recap.generic') }
        : { id: item.id, fireAt: item.fireAt, kind: 'recap', title: formatRecapTitle(item.content), body: recapBody(item.content) };
  }
}

export function requestsFor(plan: NotificationPlan, lookup: TitleLookup): NotificationRequest[] {
  return plan.items.map((item) => requestFor(item, lookup));
}
