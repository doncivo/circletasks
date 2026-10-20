import type { PlannedItem } from './notificationPlan';
import { reminderFireAt } from './recurrenceNext';
import type { LocalDate } from './types';

export type ReminderBodyItem = Exclude<PlannedItem, { readonly kind: 'recap' }>;

export interface NotificationBodyContext {
  readonly date?: string | null;
  readonly time?: string | null;
  readonly allDay?: boolean;
}

export interface NotificationBodyParts {
  readonly day: string | null;
  readonly time: string | null;
  readonly allDay: boolean;
  readonly shifted: boolean;
  readonly snoozed: boolean;
}

/** Description sans texte : l'heure appartient à l'élément, jamais à sa sonnerie. */
export function bodyParts(item: ReminderBodyItem, context: NotificationBodyContext = {}): NotificationBodyParts {
  const snoozed = item.kind === 'snooze';
  const kind = snoozed ? item.originKind : item.kind;
  const allDay = kind === 'event' && context.allDay === true;
  const deadline = snoozed ? null : reminderFireAt(item.scheduledAt.slice(0, 10) as LocalDate, item.scheduledAt.slice(11), -item.offsetMin);
  const date = snoozed ? item.occurrenceDate ?? context.date ?? null : deadline?.slice(0, 10) ?? null;
  const time = allDay ? null : snoozed ? context.time ?? null : deadline?.slice(11) ?? null;
  return {
    day: date !== null && (kind === 'event' || date !== item.fireAt.slice(0, 10)) ? date : null,
    time,
    allDay,
    shifted: !snoozed && item.scheduledAt !== item.fireAt,
    snoozed,
  };
}
