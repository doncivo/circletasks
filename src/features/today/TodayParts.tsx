import { BookOpen, CalendarDays, ShoppingCart, Sunrise, Target } from 'lucide-react';
import type { ChecklistSummary } from '../../domain/model';
import type { TodayEventEntry, TodayGoalEntry } from '../../domain/todayList';
import { t } from '../../i18n';
import { Icon, IconView, resolveIconRefColor } from '../../ui';

/**
 * Éléments d'Aujourd'hui fournis par d'autres modules (A-01) : objectif épinglé, événements (lecture seule),
 * checklists du jour. Présentation seule : les données viennent de `todaySources`.
 */

export function TodayGoalCard({ entry, compact }: { entry: TodayGoalEntry; compact: boolean }) {
  const { goal, progress } = entry;
  return (
    <section className="ct-today-goal" data-compact={compact} aria-label={t('today.goalCaption')}>
      {goal.icon ? (
        <IconView icon={goal.icon} size={compact ? 24 : 30} color={resolveIconRefColor(goal.icon)} />
      ) : (
        <Icon icon={Target} size={compact ? 24 : 30} color="var(--ct-color-goal)" />
      )}
      <div className="ct-today-goal__body">
        <span className="ct-today-goal__caption" aria-hidden="true">
          {t('today.goalCaption')}
        </span>
        <span className="ct-today-goal__title">{goal.title}</span>
      </div>
      <span className="ct-today-goal__progress" aria-label={t('today.goalProgress', { done: progress.done, total: progress.total })}>
        {progress.done}/{progress.total}
      </span>
    </section>
  );
}

/** Bandeau d'un événement du jour (Main.html : « 10:00 Point client · Google Agenda »), lecture seule. */
export function TodayEventBand({ event, compact }: { event: TodayEventEntry; compact: boolean }) {
  return (
    <li className="ct-today-event" data-compact={compact}>
      {event.icon ? <IconView icon={event.icon} size={22} color="var(--ct-color-event-text)" /> : <Icon icon={CalendarDays} size={22} color="var(--ct-color-event-text)" />}
      <span className="ct-today-event__time">{event.allDay ? t('today.eventAllDay') : event.startTime}</span>
      <span className="ct-today-event__title">{event.title}</span>
      {event.calendarName && <span className="ct-today-event__source">{event.calendarName}</span>}
    </li>
  );
}

export function TodayEventBands({ events, compact }: { events: readonly TodayEventEntry[]; compact: boolean }) {
  if (events.length === 0) return null;
  return (
    <ul className="ct-today-events" aria-label={t('today.eventsLabel')}>
      {events.map((event) => (
        <TodayEventBand key={event.id} event={event} compact={compact} />
      ))}
    </ul>
  );
}

/** Section « CHECKLISTS » (croquis PRD 5) : titre et progression « 3/5 », après les tâches. */
export function TodayChecklists({ items }: { items: readonly ChecklistSummary[] }) {
  if (items.length === 0) return null;
  return (
    <section className="ct-today-checklists" aria-labelledby="ct-today-checklists-title">
      <h2 id="ct-today-checklists-title" className="ct-today-checklists__title">
        {t('today.checklistsTitle')}
      </h2>
      <ul className="ct-today-checklists__list">
        {items.map(({ checklist, checked, total }) => (
          <li key={checklist.id} className="ct-today-checklists__item">
            <span className="ct-today-checklists__name">{checklist.title}</span>
            <span aria-label={t('today.checklistProgress', { checked, total })}>
              {checked}/{total}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** État vide (Main-Vide.html) : phrase, trois pastilles décoratives, phrase d'aide. */
export function TodayEmpty({ message }: { message: string }) {
  return (
    <div className="ct-today-empty">
      <p className="ct-today__empty">{message}</p>
      <div className="ct-today-empty__icons" aria-hidden="true">
        <span className="ct-today-empty__pill">
          <Icon icon={BookOpen} size={30} color="var(--ct-color-icon-green)" />
        </span>
        <span className="ct-today-empty__pill">
          <Icon icon={Sunrise} size={30} color="var(--ct-color-icon-amber)" />
        </span>
        <span className="ct-today-empty__pill">
          <Icon icon={ShoppingCart} size={30} color="var(--ct-color-icon-amber)" />
        </span>
      </div>
      <p className="ct-today-empty__help">{t('today.emptyHelp')}</p>
    </div>
  );
}
