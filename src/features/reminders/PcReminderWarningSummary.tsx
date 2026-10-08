import { useEffect, useState } from 'react';
import { REMINDER_WARNING_WINDOW_MS, warnIphoneReminders, type WarnedReminders } from '../../domain/iphoneReminderWarning';
import { t } from '../../i18n';
import { useAppContainer } from '../app/AppContainerContext';
import { createQuietHoursUseCases } from '../spaces/quietHoursUseCases';
import { useWarningContext } from './IphoneReminderWarning';
import './IphoneReminderWarning.css';

/**
 * Réglages > Rappels sur le PC (N-07 critère 7) : combien de rappels sonnent dans les 2 prochaines heures sans qu'un iPhone synchronisé les
 * ait reçus. Recalculé à chaque changement de `SyncStatus` et à chaque minute ; le PC ne fait qu'afficher. Rien n'est affiché sans rappel concerné.
 */
export function PcReminderWarningSummary() {
  const container = useAppContainer();
  const context = useWarningContext();
  const [result, setResult] = useState<WarnedReminders>({ warning: 'none', count: 0 });
  const { enabled, nowMs, devices, instantOf, localAt } = context;

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const effective = await createQuietHoursUseCases(container).listEffectiveReminders({ from: localAt(nowMs), to: localAt(nowMs + REMINDER_WARNING_WINDOW_MS) });
        // Une tâche terminée ou supprimée n\u2019est plus à rappeler.
        const taskIds = effective.filter((item) => item.reminder.targetType === 'task').map((item) => item.reminder.targetId as never);
        const open = new Set((await container.data.repos.tasks.listByIds(taskIds)).filter((task) => task.status === 'todo').map((task) => task.id as string));
        const live = effective.filter((item) => item.reminder.targetType !== 'task' || open.has(item.reminder.targetId));
        const next = warnIphoneReminders({ nowMs, fireAtMs: live.map((item) => instantOf(item.effectiveFireAt)), devices });
        if (!cancelled) setResult(next);
      } catch {
        // Lecture impossible : aucun nombre n\u2019est affiché, l\u2019avertissement par rappel (bloc Rappel, détail) reste calculé séparément.
        if (!cancelled) setResult({ warning: 'none', count: 0 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [container, enabled, nowMs, devices, instantOf, localAt]);

  if (!enabled || result.warning === 'none') return null;
  const key =
    result.warning === 'stale'
      ? result.count === 1
        ? 'reminders.status.summaryStaleOne'
        : 'reminders.status.summaryStaleMany'
      : result.count === 1
        ? 'reminders.status.summaryNoIphoneOne'
        : 'reminders.status.summaryNoIphoneMany';
  return (
    <p className="ct-reminder-warning" role="status" data-warning={result.warning}>
      {key.endsWith('One') ? t(key as 'reminders.status.summaryStaleOne') : t(key as 'reminders.status.summaryStaleMany', { n: result.count })}
    </p>
  );
}
