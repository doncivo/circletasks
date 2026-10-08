import { MoveRight, X } from 'lucide-react';
import type { Task } from '../../domain/model';
import { canMoveToSomeday } from '../../domain/someday';
import type { TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { Icon, SomedayIcon, type SwipeRowAction, type SwipeRowRight } from '../../ui';

/**
 * Gestes de ligne d'une tâche (A-07) : balayage à droite (terminer / rouvrir), à gauche (Reporter, Un jour, Supprimer). Aucune règle
 * métier ici : chaque rappel appelle le cas d'usage existant de l'écran (annulation 5 s de T-13 comprise) et rend vrai s'il a abouti.
 */
export interface TaskGestureApi {
  /** Termine ou rouvre (T-04) ; vrai si abouti. */
  complete(id: TaskId): Promise<boolean>;
  /** Pose « Reporter » : demain (T-05), ou d'abord la portée pour une occurrence de série (T-10). */
  postpone(task: Task): void;
  /** SD-03. */
  sendToSomeday(id: TaskId): Promise<boolean>;
  /** Ouvre la confirmation habituelle de suppression (T-08, portée T-10) : jamais de suppression en un geste. */
  requestDelete(id: TaskId): void;
}

export interface TaskGestureProps {
  readonly right: SwipeRowRight;
  readonly left: readonly SwipeRowAction[];
}

export function taskGestureProps(task: Task, api: TaskGestureApi): TaskGestureProps {
  const done = task.status === 'done';
  const left: SwipeRowAction[] = [];
  // Reporter et « Un jour » ne s'appliquent qu'à une tâche à faire ; « Un jour » refuse en plus une tâche répétée ou déjà rangée (SD-03, QB-11).
  if (!done) left.push({ id: 'postpone', label: t('gestures.postpone'), icon: <Icon icon={MoveRight} size={20} />, tone: 'soft', onSelect: () => api.postpone(task) });
  if (canMoveToSomeday(task)) left.push({ id: 'someday', label: t('gestures.someday'), icon: <SomedayIcon size={20} />, tone: 'accent', onSelect: () => void api.sendToSomeday(task.id) });
  left.push({ id: 'delete', label: t('gestures.delete'), icon: <Icon icon={X} size={20} />, tone: 'danger', onSelect: () => api.requestDelete(task.id) });
  return {
    right: { label: t(done ? 'gestures.reopen' : 'gestures.complete'), tone: done ? 'reopen' : 'complete', onCommit: () => api.complete(task.id) },
    left,
  };
}
