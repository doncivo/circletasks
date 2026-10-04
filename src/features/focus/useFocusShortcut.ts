import { useEffect } from 'react';
import type { TaskId } from '../../domain/types';
import { useAppContainer } from '../app/AppContainerContext';
import { launchFocus } from './focusActions';

/**
 * Ctrl+Maj+F (registre de raccourcis, `list.focus`, D-04) : lance une session Focus sur la tâche sélectionnée. Sans tâche
 * sélectionnée, ou si elle est terminée, le raccourci décline (l'événement n'est pas consommé).
 */
export function useFocusShortcut(taskId: TaskId | null): void {
  const container = useAppContainer();
  useEffect(() => {
    if (!taskId) return undefined;
    return container.shortcuts.register('list.focus', (): boolean => {
      const task = container.taskEntities.get(taskId);
      if (!task || task.status !== 'todo' || task.deletedAt !== null) return false;
      void launchFocus(container, taskId);
      return true;
    });
  }, [container, taskId]);
}
