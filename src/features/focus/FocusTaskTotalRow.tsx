import { useEffect, useState } from 'react';
import { focusTotalMinutes, type FocusTotal } from '../../domain/focusTotals';
import type { TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { formatFocusDuration, formatFocusSessions } from '../../i18n/formatFocus';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { DetailRow } from '../tasks/DetailRow';
import { focusStore } from './focusStore';

/**
 * Ligne « Concentration » de la fiche d'une tâche (F-03 critère 3) : « 50 min · 2 sessions », en lecture seule sur PC et iPhone, absente
 * tant que la tâche n'a aucune session terminée. Relue à la clôture d'une session (la session en cours s'ajoute à sa fermeture) ; une
 * session reste comptée même si la tâche est supprimée ensuite.
 */
export function FocusTaskTotalRow({ taskId }: { readonly taskId: TaskId }) {
  const container = useAppContainer();
  const revision = useFeatureStore(focusStore, (s) => s.revision);
  const [loaded, setLoaded] = useState<{ readonly id: TaskId; readonly total: FocusTotal } | null>(null);

  useEffect(() => {
    let alive = true;
    container.data.repos.focusSessions.totalsForTask(taskId).then(
      (total) => alive && setLoaded({ id: taskId, total }),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [container, taskId, revision]);

  if (loaded?.id !== taskId || loaded.total.sessions === 0) return null;
  return (
    <DetailRow label={t('focus.taskRow')}>
      {t('focus.taskTotal', { duration: formatFocusDuration(focusTotalMinutes(loaded.total)), sessions: formatFocusSessions(loaded.total.sessions) })}
    </DetailRow>
  );
}
