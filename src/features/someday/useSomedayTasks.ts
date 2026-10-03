import { useEffect, useMemo } from 'react';
import type { ItemFilter } from '../../domain/itemFilter';
import type { Task } from '../../domain/model';
import { selectSomedayTasks } from '../../domain/someday';
import { useFeatureStore, useTaskEntities } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useEffectiveProjectFilter } from '../spaces';
import { somedayStore } from './somedayStore';

/** Filtre d'espace et de projet global (ES-03, QB-15) sous la forme attendue par le domaine. */
export function useItemFilter(): ItemFilter {
  const space = useAppStore((s) => s.spaceFilter);
  const project = useEffectiveProjectFilter();
  return useMemo(() => ({ space, project }), [space, project]);
}

export interface SomedayTasks {
  /** Tâches « Un jour » du filtre actif, dans l'ordre manuel (SD-04). */
  readonly tasks: readonly Task[];
  /** Nombre de tâches non terminées du filtre actif (sous-titre, badge de l'icône horloge). */
  readonly count: number;
}

/**
 * Tâches « Un jour » du filtre global, lues dans la source unique (`taskEntities`) : une tâche créée, planifiée, terminée ou
 * renvoyée dans « Un jour » depuis n'importe quel écran met la liste et le compteur à jour. Chaque affichage relit la liste en base.
 */
export function useSomedayTasks(): SomedayTasks {
  const entities = useTaskEntities();
  const filter = useItemFilter();
  const load = useFeatureStore(somedayStore, (s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  const tasks = useMemo(() => selectSomedayTasks(entities.values(), filter), [entities, filter]);
  return { tasks, count: tasks.length };
}
