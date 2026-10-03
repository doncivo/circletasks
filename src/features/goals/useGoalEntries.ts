import { useEffect, useState } from 'react';
import type { TodayGoalEntry } from '../../domain/todayList';
import type { LocalDate, SpaceFilter } from '../../domain/types';
import { useAppContainer } from '../app/AppContainerContext';
import { loadPinnedGoalEntries, subscribeGoalChanges } from './goalsSource';

/**
 * Objectifs épinglés affichés pour le jour `date` et le filtre d'espace, relus à chaque changement d'objectif ou de tâche rattachée.
 * Sert au bandeau de la Semaine (OB-02 critère 6) ; Aujourd'hui passe par `todaySources`. Une lecture manquée garde l'affichage courant.
 */
export function usePinnedGoalEntries(date: LocalDate, filter: SpaceFilter): readonly TodayGoalEntry[] {
  const container = useAppContainer();
  const [entries, setEntries] = useState<readonly TodayGoalEntry[]>([]);
  useEffect(() => {
    let current = true;
    let request = 0;
    const reload = (): void => {
      const id = ++request;
      loadPinnedGoalEntries(container, date, filter).then(
        (loaded) => {
          if (current && id === request) setEntries(loaded);
        },
        () => undefined,
      );
    };
    reload();
    const off = subscribeGoalChanges(container, reload);
    return () => {
      current = false;
      off();
    };
  }, [container, date, filter]);
  return entries;
}
