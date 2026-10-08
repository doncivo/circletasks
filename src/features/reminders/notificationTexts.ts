import type { CalendarEvent, Routine, Task } from '../../domain/model';
import type { NotificationPlan, PlannedItem } from '../../domain/notificationPlan';
import type { Recap } from '../../domain/recap';
import { t, tDynamic } from '../../i18n';
import { formatTime } from '../../i18n/format';
import type { NotificationRequest } from '../../platform/notifications';
import { formatRecapTitle } from './recapText';

/**
 * Textes des notifications (N-01, ADR 0012 avenant N1.3) : tout vient de `src/i18n` (espace `notifications`). Les titres et corps ne vont
 * JAMAIS dans le journal technique (codes et nombres seulement). Un titre vide est refusé par `replace` : repli sur « Sans titre ».
 */

/** Lignes du corps d'un récapitulatif avant « et N autres » (corps limité en longueur pour iOS, N-04 critère 11). */
export const RECAP_BODY_LINES = 5;

/** « 5 min », « 1 heure », « 1 jour », « 1 semaine » : mêmes mots que les cases d'avance (reminders.choice*). */
export function advanceLabel(offsetMin: number): string {
  return offsetMin === 10080 ? t('notifications.advance.week') : tDynamic(`reminders.choice${String(offsetMin)}` as 'reminders.choice5');
}

/** Corps d'un rappel : « À l'heure » (avance 0) ou « Dans 30 min ». */
export function reminderBody(offsetMin: number): string {
  return offsetMin === 0 ? t('notifications.body.atTime') : t('notifications.body.inAdvance', { advance: advanceLabel(offsetMin) });
}

/** Corps d'un récapitulatif du jour : les 5 premières lignes (heure et titre), puis « et {n} autres ». */
export function recapBody(content: Recap): string {
  const lines = content.lines.slice(0, RECAP_BODY_LINES).map((line) => (line.time === null ? line.title : `${formatTime(line.time)} ${line.title}`));
  if (content.lines.length > RECAP_BODY_LINES) lines.push(t('notifications.recap.more', { n: content.lines.length - RECAP_BODY_LINES }));
  return lines.join('\n');
}

export interface TitleLookup {
  readonly tasks: ReadonlyMap<string, Pick<Task, 'title'>>;
  readonly routines: ReadonlyMap<string, Pick<Routine, 'title'>>;
  readonly events: ReadonlyMap<string, Pick<CalendarEvent, 'title'>>;
}

const titled = (title: string | undefined): string => (title === undefined || title.trim() === '' ? t('notifications.untitled') : title);

/** Requête de notification d'un élément du plan. */
export function requestFor(item: PlannedItem, lookup: TitleLookup): NotificationRequest {
  switch (item.kind) {
    case 'task':
      return { id: item.id, fireAt: item.fireAt, kind: 'task', title: titled(lookup.tasks.get(item.targetId)?.title), body: reminderBody(item.offsetMin) };
    case 'routine':
      return { id: item.id, fireAt: item.fireAt, kind: 'routine', title: titled(lookup.routines.get(item.targetId)?.title), body: reminderBody(item.offsetMin) };
    case 'event':
      return { id: item.id, fireAt: item.fireAt, kind: 'event', title: titled(lookup.events.get(item.targetId)?.title), body: reminderBody(item.offsetMin) };
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
