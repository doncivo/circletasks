import { BookOpen, CalendarDays, ShoppingCart, Sunrise, Target } from 'lucide-react';
import type { ChecklistSummary, Space } from '../../domain/model';
import type { ChecklistId } from '../../domain/types';
import type { TodayEventEntry, TodayGoalEntry } from '../../domain/todayList';
import { t } from '../../i18n';
import { Icon, IconView, resolveIconRefColor, spaceTextColor } from '../../ui';
import { ChecklistIcon } from '../checklists/ChecklistIcon';

/**
 * Éléments d'Aujourd'hui fournis par d'autres modules (A-01) : objectif épinglé, événements (lecture seule),
 * checklists du jour. Présentation seule : les données viennent de `todaySources`.
 */

/**
 * Encadré d'un objectif épinglé (OB-02, Main.html) : bord #3F7FC4, icône cible, « OBJECTIF DE LA SEMAINE », titre, avancement « 2/5 »
 * (sans compteur si aucune tâche n'est rattachée, « Atteint » une fois l'objectif atteint, OB-04). Toucher l'encadré ouvre l'écran Objectif.
 */
export function TodayGoalCard({ entry, compact, onOpen }: { entry: TodayGoalEntry; compact: boolean; onOpen: () => void }) {
  const { goal, progress } = entry;
  const achieved = goal.status === 'achieved';
  const summary = achieved
    ? t('goals.achieved')
    : progress.total > 0
      ? t('today.goalProgress', { done: progress.done, total: progress.total })
      : null;
  return (
    <button
      type="button"
      className="ct-today-goal"
      data-compact={compact}
      aria-label={summary ? t('today.goalCardWith', { title: goal.title, summary }) : t('today.goalCard', { title: goal.title })}
      onClick={onOpen}
    >
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
      {achieved ? (
        <span className="ct-today-goal__achieved" aria-hidden="true">
          {t('goals.achieved')}
        </span>
      ) : (
        progress.total > 0 && (
          <span className="ct-today-goal__progress" aria-hidden="true">
            {progress.done}/{progress.total}
          </span>
        )
      )}
    </button>
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

/**
 * Section « CHECKLISTS » (croquis PRD 5, C-03) : une ligne par checklist prévue ce jour (icône, titre, « 3/5 »), après les tâches.
 * Toucher la ligne ouvre l'onglet Checklists sur elle. Sous « Tout », l'espace est écrit dans sa couleur sous le titre (critère 7).
 */
export function TodayChecklists({
  items,
  spaces,
  showSpace,
  onOpen,
}: {
  items: readonly ChecklistSummary[];
  spaces: readonly Space[];
  showSpace: boolean;
  onOpen: (id: ChecklistId) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="ct-today-checklists" aria-labelledby="ct-today-checklists-title">
      <h2 id="ct-today-checklists-title" className="ct-today-checklists__title">
        {t('today.checklistsTitle')}
      </h2>
      <ul className="ct-today-checklists__list">
        {items.map(({ checklist, checked, total }) => {
          const space = showSpace ? spaces.find((candidate) => candidate.id === checklist.spaceId) : undefined;
          return (
            <li key={checklist.id} className="ct-today-checklists__row">
              <button type="button" className="ct-today-checklists__item" onClick={() => onOpen(checklist.id as ChecklistId)}>
                <ChecklistIcon icon={checklist.icon} size={24} />
                <span className="ct-today-checklists__text">
                  <span className="ct-today-checklists__name">{checklist.title}</span>
                  {space && (
                    <span className="ct-today-checklists__space" style={{ color: spaceTextColor(space.color) }}>
                      {space.name}
                    </span>
                  )}
                </span>
                <span className="ct-today-checklists__progress" aria-label={t('today.checklistProgress', { checked, total })}>
                  {checked}/{total}
                </span>
              </button>
            </li>
          );
        })}
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
