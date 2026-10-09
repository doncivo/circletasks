import { useMemo } from 'react';
import type { LocalDate } from '../../domain/types';
import { useFeatureStore } from '../app/AppContainerContext';
import { useEffectiveProjectFilter, useAnnounceCreation } from '../spaces';
import { scheduleOf } from '../tasks/TaskCreateSheet';
import { todayStore } from '../today/todayStore';
import type { AddSheetProps } from './AddSheet';

/**
 * Segment « Tâche » de la feuille Ajout ouverte hors d'Aujourd'hui et de la Semaine (onglets Événements et Routines, E-01 critère 2) :
 * la tâche est créée comme dans Aujourd'hui (même cas d'usage, même règle d'espace et de rappels), datée du jour proposé.
 */
export function useStandaloneTaskSheet(viewedDate: LocalDate): AddSheetProps['taskSheet'] {
  const addTask = useFeatureStore(todayStore, (s) => s.addTask);
  const projectFilter = useEffectiveProjectFilter();
  const announceCreation = useAnnounceCreation();
  return useMemo(
    () => ({
      viewedDate,
      initialProjectId: projectFilter,
      onCreate: async (input) => {
        const result = await addTask(input.title, input.spaceId, { ...scheduleOf(input.choice), recurrence: input.recurrence, reminderOffsets: input.reminderOffsets, goalId: input.goalId, taskId: input.taskId }, input.icon, input.projectId);
        if (result.ok) announceCreation(input.spaceId);
        return result.ok;
      },
    }),
    [viewedDate, projectFilter, addTask, announceCreation],
  );
}
