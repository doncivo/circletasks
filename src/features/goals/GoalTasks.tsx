import type { Task } from '../../domain/model';
import { t } from '../../i18n';
import { formatWeekDayHeader } from '../../i18n/format';
import { Checkbox } from '../../ui';

/** Jour abrégé d'une tâche (« lun. »), vide pour une tâche sans date. */
function shortDay(task: Task): string {
  return task.date ? formatWeekDayHeader(task.date).weekday.toLocaleLowerCase('fr-FR') : '';
}

export interface GoalTasksProps {
  readonly tasks: readonly Task[];
  readonly onToggle: (task: Task) => void;
  readonly onOpen: (task: Task) => void;
}

/**
 * Tâches rattachées à un objectif (OB-03 critère 5, Objectif.html) : case, titre et jour abrégé. Cocher termine la tâche (T-04) ;
 * toucher le titre ouvre la fiche.
 */
export function GoalTasks({ tasks, onToggle, onOpen }: GoalTasksProps) {
  if (tasks.length === 0) return <p className="ct-goal__noTasks">{t('goals.noTasks')}</p>;
  return (
    <ul className="ct-goal__tasks">
      {tasks.map((task) => {
        const done = task.status === 'done';
        return (
          <li key={task.id} className="ct-goal-task" data-done={done}>
            <Checkbox checked={done} size={22} onChange={() => onToggle(task)} label={t(done ? 'tasks.reopen' : 'tasks.complete', { title: task.title })} />
            <button type="button" className="ct-goal-task__title" data-done={done} onClick={() => onOpen(task)}>
              {task.title}
            </button>
            <span className="ct-goal-task__day">{shortDay(task)}</span>
          </li>
        );
      })}
    </ul>
  );
}
