import type { Task } from '../../domain/model';
import { DELETE_SCOPES, type SeriesScope } from '../../domain/recurrenceEdit';
import { t } from '../../i18n';
import { ChoiceDialog, ConfirmDialog } from '../../ui';

interface DeleteTaskConfirmProps {
  task: Pick<Task, 'title' | 'recurrenceId'>;
  /** `scope` : choix « cette occurrence / toutes les suivantes », seulement pour une occurrence récurrente (T-10). */
  onConfirm: (scope?: SeriesScope) => void;
  onCancel: () => void;
}

/**
 * Confirmation « Supprimer « <titre> » ? » (T-08) : fiche détail et touche Suppr sur une ligne. Pour une
 * occurrence récurrente, la question devient « Cette occurrence » / « Toutes les suivantes » / « Annuler »
 * (T-10 critère 7).
 */
export function DeleteTaskConfirm({ task, onConfirm, onCancel }: DeleteTaskConfirmProps) {
  if (task.recurrenceId !== null) {
    return (
      <ChoiceDialog
        title={t('tasks.seriesDeleteTitle', { title: task.title })}
        description={t('tasks.seriesDeleteBody')}
        options={DELETE_SCOPES.map((id) => ({ id, label: t(id === 'occurrence' ? 'tasks.seriesScopeOccurrence' : 'tasks.seriesScopeFollowing') }))}
        optionVariant="danger"
        onChoose={(scope) => onConfirm(scope)}
        onCancel={onCancel}
      />
    );
  }
  return (
    <ConfirmDialog
      title={t('tasks.deleteConfirmTitle', { title: task.title })}
      description={t('tasks.deleteConfirmBody')}
      confirmLabel={t('tasks.deleteConfirm')}
      onConfirm={() => onConfirm()}
      onCancel={onCancel}
    />
  );
}
