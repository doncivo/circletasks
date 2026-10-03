import { useCallback } from 'react';
import type { ReactNode } from 'react';
import type { Task } from '../../domain/model';
import { todayLocal } from '../../domain/clock';
import type { ScheduleSomedayTarget } from '../../domain/someday';
import type { TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { useLayout } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { useAnnounceCreation, useDefaultSpaceId, useEffectiveProjectFilter } from '../spaces';
import { taskSubtitle } from '../tasks/taskLine';
import { somedayStore } from './somedayStore';
import { useSomedayTasks } from './useSomedayTasks';

/**
 * Données et actions communes à l'écran iPhone et au panneau PC « Un jour » : tâches du filtre global, compteur et sous-titre,
 * sous-ligne « espace · projet », ajout sans date, case de la ligne. Aucun état de filtre ici : il est global (`useAppStore`).
 */
export function useSomedayView() {
  const container = useAppContainer();
  const layout = useLayout();
  const appDay = useAppStore((s) => s.day);
  const { tasks, count } = useSomedayTasks();
  const spaces = useAppStore((s) => s.spaces);
  const projects = useAppStore((s) => s.projects);
  const spaceFilter = useAppStore((s) => s.spaceFilter);
  const projectFilter = useEffectiveProjectFilter();
  const defaultSpaceId = useDefaultSpaceId();
  const announceCreation = useAnnounceCreation();
  const openDetail = useNavigationStore((s) => s.openDetail);
  const status = useFeatureStore(somedayStore, (s) => s.status);
  const errorKey = useFeatureStore(somedayStore, (s) => s.errorKey);
  const actionErrorKey = useFeatureStore(somedayStore, (s) => s.actionErrorKey);
  const create = useFeatureStore(somedayStore, (s) => s.create);
  const toggleDone = useFeatureStore(somedayStore, (s) => s.toggleDone);
  const schedule = useFeatureStore(somedayStore, (s) => s.schedule);

  /** Champ d'ajout (SD-01 critère 3) : tâche sans date, espace selon T-01 / ES-02, projet du filtre actif. */
  const addInline = useCallback(
    async (title: string): Promise<boolean> => {
      if (!defaultSpaceId) return false;
      const result = await create({ title, spaceId: defaultSpaceId, projectId: projectFilter });
      if (result.ok) announceCreation(defaultSpaceId);
      return result.ok;
    },
    [create, defaultSpaceId, projectFilter, announceCreation],
  );

  const subtitleOf = useCallback(
    (task: Task): ReactNode => taskSubtitle(task, { spaces, showSpace: spaceFilter === 'all', rule: undefined, projects }),
    [spaces, projects, spaceFilter],
  );

  const subtitle = count === 0 ? t('someday.subtitleNone') : count === 1 ? t('someday.subtitleOne') : t('someday.subtitle', { count });
  const spaceName = spaceFilter === 'all' ? null : (spaces.find((space) => space.id === spaceFilter)?.name ?? null);
  const emptyMessage = spaceName ? t('someday.emptySpace', { space: spaceName }) : t('someday.empty');

  return {
    layout,
    /** Jour courant de l'app (suit minuit) : base des boutons « Aujourd'hui » / « Demain » et du sélecteur de date. */
    today: appDay ?? todayLocal(container.clock),
    tasks,
    count,
    spaces,
    projects,
    spaceFilter,
    projectFilter,
    defaultSpaceId,
    announceCreation,
    subtitle,
    emptyMessage,
    status,
    errorKey,
    actionErrorKey,
    create,
    addInline,
    subtitleOf,
    toggleDone: (id: TaskId) => void toggleDone(id),
    schedule: (ids: readonly TaskId[], target: ScheduleSomedayTarget) => schedule(ids, target),
    openTask: (id: TaskId) => openDetail({ type: 'task', id }),
  };
}

export type SomedayView = ReturnType<typeof useSomedayView>;
