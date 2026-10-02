import type { Task } from '../../domain/model';
import { t } from '../../i18n';
import { ChoiceDialog } from '../../ui';
import type { TaskDetailEdits } from './useTaskDetailEdits';

const scopeOptions = () =>
  [
    { id: 'occurrence' as const, label: t('tasks.seriesScopeOccurrence') },
    { id: 'following' as const, label: t('tasks.seriesScopeFollowing') },
  ] as const;

/**
 * Questions « Cette occurrence / Toutes les suivantes » de la fiche (T-10) : modification d'un champ ou de la note, enregistrement
 * de la feuille « Modifier la tâche », report d'une occurrence.
 */
export function TaskDetailDialogs({ task, edits }: { task: Pick<Task, 'title'>; edits: TaskDetailEdits }) {
  const { scope, sheet, postponeScope } = edits;
  return (
    <>
      {sheet.pending && (
        <ChoiceDialog
          title={t('tasks.seriesEditTitle', { title: task.title })}
          description={t('tasks.seriesEditBody')}
          options={scopeOptions()}
          onChoose={sheet.choose}
          onCancel={sheet.cancel}
        />
      )}
      {scope.pending && (
        <ChoiceDialog
          title={t('tasks.seriesEditTitle', { title: task.title })}
          description={t('tasks.seriesEditBody')}
          options={scopeOptions()}
          onChoose={scope.choose}
          onCancel={scope.cancel}
        />
      )}
      {postponeScope.pending && (
        <ChoiceDialog
          title={t('tasks.seriesPostponeTitle', { title: task.title })}
          description={t('tasks.seriesPostponeBody')}
          options={scopeOptions()}
          onChoose={postponeScope.choose}
          onCancel={postponeScope.cancel}
        />
      )}
    </>
  );
}
