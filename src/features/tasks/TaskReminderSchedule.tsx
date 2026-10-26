import type { ReminderOffsetMin, Space, Task } from '../../domain/model';
import { effectiveFireAt } from '../../domain/quietHours';
import { reminderFireAt } from '../../domain/recurrenceNext';
import { canHaveReminders, sortReminderOffsets } from '../../domain/reminders';
import { t, tDynamic } from '../../i18n';
import { formatDetailDate, formatTime } from '../../i18n/format';
import { tTaskRefonte } from '../../i18n/taskRefonteText';
import type { LocalDate } from '../../domain/types';

/** Heure locale flottante identique au planificateur ; ne prétend pas prouver une notification reçue. */
export function TaskReminderSchedule({ task, reminders, space, today }: { task: Task; reminders: readonly ReminderOffsetMin[]; space: Space | undefined; today: LocalDate }) {
  if (reminders.length === 0) return <>{t('detail.remindersNone')}</>;
  if (!canHaveReminders(task) || task.status !== 'todo' || task.date === null || task.time === null) return <span className="ct-task-detail__reminderInactive">{tTaskRefonte('inactive')}</span>;
  const { date, time } = task;
  return <span className="ct-task-detail__reminderSchedule">
    {sortReminderOffsets(reminders).map((offset) => {
      const planned = reminderFireAt(date, time, offset);
      const actual = effectiveFireAt(planned, space?.quietHours ?? []);
      return <span key={offset} className="ct-task-detail__reminderTime">
        <span>{formatDetailDate(actual.slice(0, 10), actual.slice(0, 4) !== today.slice(0, 4))} · {formatTime(actual.slice(11, 16))}</span>
        <span className="ct-task-detail__sub">{tDynamic(`detail.reminderOffset${String(offset)}` as 'detail.reminderOffset0')}</span>
        {actual !== planned && <span className="ct-task-detail__sub">{tTaskRefonte('quiet', { space: space?.name ?? '' })}</span>}
      </span>;
    })}
  </span>;
}
