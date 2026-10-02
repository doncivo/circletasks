import type { Task } from '../../domain/model';
import { t } from '../../i18n';
import { ConfirmDialog } from '../../ui';

interface DeleteTaskConfirmProps {
  task: Pick<Task, 'title'>;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirmation « Supprimer « <titre> » ? » (T-08) : fiche détail et touche Suppr sur une ligne. */
export function DeleteTaskConfirm({ task, onConfirm, onCancel }: DeleteTaskConfirmProps) {
  return (
    <ConfirmDialog
      title={t('tasks.deleteConfirmTitle', { title: task.title })}
      description={t('tasks.deleteConfirmBody')}
      confirmLabel={t('tasks.deleteConfirm')}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
