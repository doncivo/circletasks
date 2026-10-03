import { Check } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import { goalWeekNumber, historyStatusOf } from '../../domain/goalRules';
import type { Task } from '../../domain/model';
import type { GoalId } from '../../domain/types';
import { t } from '../../i18n';
import { Button, Icon } from '../../ui';
import { useAppContainer, useFeatureStore, useTaskEntities } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { goalsStore } from './goalsStore';
import './GoalHistory.css';

/**
 * Section « SEMAINES PRÉCÉDENTES » de l'écran Objectif (OB-06, Objectif.html ; écart de PRD tranché : l'historique est ici et non dans
 * Statistiques) : de la plus récente à la plus ancienne, « S38 », titre, badge « Atteint » ou « Non atteint » (un objectif resté ouvert
 * sans réponse est « Non atteint »), « Reconduit en S39 » sous le titre. Toucher une ligne la déplie sur ses tâches rattachées, un
 * second toucher la replie. Le filtre d'espace global s'applique ; chargement par pages de 20 semaines.
 */
export function GoalHistory() {
  const container = useAppContainer();
  const filter = useAppStore((s) => s.spaceFilter);
  const appDay = useAppStore((s) => s.day);
  const history = useFeatureStore(goalsStore, (s) => s.history);
  const carriedTo = useFeatureStore(goalsStore, (s) => s.historyCarriedTo);
  const hasMore = useFeatureStore(goalsStore, (s) => s.historyHasMore);
  const loadHistory = useFeatureStore(goalsStore, (s) => s.loadHistory);
  const loadMore = useFeatureStore(goalsStore, (s) => s.loadMoreHistory);
  const loadGoalTasks = useFeatureStore(goalsStore, (s) => s.loadGoalTasks);
  const entities = useTaskEntities();
  const [open, setOpen] = useState<ReadonlySet<GoalId>>(new Set());
  const today = appDay ?? todayLocal(container.clock);

  useEffect(() => {
    void loadHistory(today, filter);
  }, [loadHistory, today, filter]);

  // Tâches rattachées des lignes dépliées, lues dans la source unique (une tâche rouverte ou détachée ailleurs s'y voit).
  const tasksByGoal = useMemo(() => {
    const grouped = new Map<GoalId, Task[]>();
    for (const task of entities.values()) {
      if (task.goalId === null || task.deletedAt !== null || !open.has(task.goalId)) continue;
      const list = grouped.get(task.goalId) ?? [];
      list.push(task);
      grouped.set(task.goalId, list);
    }
    for (const list of grouped.values()) list.sort((a, b) => (a.date ?? '9999') < (b.date ?? '9999') ? -1 : (a.date ?? '9999') > (b.date ?? '9999') ? 1 : a.sortOrder - b.sortOrder);
    return grouped;
  }, [entities, open]);

  if (history.length === 0) return null;

  function toggle(id: GoalId): void {
    const expanding = !open.has(id);
    setOpen((current) => {
      const next = new Set(current);
      if (expanding) next.add(id);
      else next.delete(id);
      return next;
    });
    if (expanding) void loadGoalTasks(id);
  }

  return (
    <section className="ct-goal-history" aria-labelledby="ct-goal-history-title">
      <h2 id="ct-goal-history-title" className="ct-goal-history__title">
        {t('goals.history.title')}
      </h2>
      <ul className="ct-goal-history__list">
        {history.map((goal) => {
          const expanded = open.has(goal.id);
          const status = historyStatusOf(goal);
          const reconduit = carriedTo.get(goal.id);
          const tasks = tasksByGoal.get(goal.id) ?? [];
          return (
            <li key={goal.id} className="ct-goal-history__item">
              <button type="button" className="ct-goal-history__row" aria-expanded={expanded} onClick={() => toggle(goal.id)}>
                <span className="ct-goal-history__week">{t('goals.history.week', { number: goalWeekNumber(goal.weekStart) })}</span>
                <span className="ct-goal-history__main">
                  <span className="ct-goal-history__goal">{goal.title}</span>
                  {reconduit && <span className="ct-goal-history__carried">{t('goals.history.carriedTo', { week: goalWeekNumber(reconduit) })}</span>}
                </span>
                <span className="ct-goal-history__badge" data-status={status}>
                  {t(status === 'achieved' ? 'goals.achieved' : 'goals.notAchieved')}
                </span>
              </button>
              {expanded && (
                <ul className="ct-goal-history__tasks" aria-label={t('goals.history.tasksLabel', { title: goal.title })}>
                  {tasks.length === 0 ? (
                    <li className="ct-goal-history__none">{t('goals.noTasks')}</li>
                  ) : (
                    tasks.map((task) => {
                      const done = task.status === 'done';
                      return (
                        <li key={task.id} className="ct-goal-history__task" data-done={done}>
                          <span className="ct-goal-history__box" data-checked={done} aria-hidden="true">
                            {done && <Icon icon={Check} size={12} strokeWidth={3.4} color="var(--ct-color-accent-on)" />}
                          </span>
                          <span className="ct-goal-history__taskTitle">{task.title}</span>
                          <span className="ct-visually-hidden">{t(done ? 'goals.history.done' : 'goals.history.notDone')}</span>
                        </li>
                      );
                    })
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <Button variant="secondary" fullWidth onClick={() => void loadMore()}>
          {t('goals.history.more')}
        </Button>
      )}
    </section>
  );
}
