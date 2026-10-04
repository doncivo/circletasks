import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Task } from '../../domain/model';
import type { ExternalEventId } from '../../domain/types';
import { useAppContainer } from '../app/AppContainerContext';
import { createLinkedTaskUseCases } from './linkedTaskUseCases';

/**
 * Tâche vivante liée à un événement externe (K-04), relue à chaque changement des tâches publiées : une création, une annulation
 * (« Annuler », Ctrl+Z), une suppression ou un déplacement de la tâche mettent le bouton à jour (« Créer une tâche » / « Voir la tâche
 * liée »). `undefined` tant que la première lecture n'est pas revenue.
 */
export function useLinkedTask(eventId: ExternalEventId | undefined): Task | null | undefined {
  const container = useAppContainer();
  const entities = useSyncExternalStore(container.taskEntities.subscribe, container.taskEntities.getSnapshot);
  const [found, setFound] = useState<{ readonly eventId: ExternalEventId; readonly task: Task | null } | null>(null);

  useEffect(() => {
    if (eventId === undefined) return undefined;
    let alive = true;
    void createLinkedTaskUseCases(container)
      .linkedTask(eventId)
      .then(
        (task) => alive && setFound({ eventId, task }),
        () => alive && setFound({ eventId, task: null }),
      );
    return () => {
      alive = false;
    };
  }, [container, eventId, entities]);

  return found !== null && found.eventId === eventId ? found.task : undefined;
}
