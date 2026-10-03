import { Target } from 'lucide-react';
import type { ReactNode } from 'react';
import { Icon, spaceTextColor } from '../../ui';
import type { Project, RecurrenceFields, Routine, Space, Task } from '../../domain/model';
import { recurrenceLabel } from '../../domain/recurrenceLabel';
import { taskLineSegments } from '../../domain/taskLine';
import { t } from '../../i18n';
import { formatMessageRef } from '../../i18n/formatRecurrence';

/** Marque « rattachée à l'objectif » (OB-03 critère 3) : icône cible #3F7FC4, libellé accessible « Rattachée à l'objectif ». */
export function TaskGoalMark({ size = 16 }: { size?: number }) {
  return (
    <span className="ct-task-goalMark" role="img" aria-label={t('goals.attachedMark')} style={{ display: 'inline-flex', verticalAlign: 'middle' }}>
      <Icon icon={Target} size={size} color="var(--ct-color-goal)" />
    </span>
  );
}

export interface TaskSubtitleOptions {
  readonly spaces: readonly Space[];
  /** Filtre « Tout » : l'espace est affiché en couleur (« 09:00 · Pro »). */
  readonly showSpace: boolean;
  /** Règle de la série (T-09), si connue. */
  readonly rule: RecurrenceFields | undefined;
  /** « Un jour » : projets connus ; le nom du projet de la tâche suit l'espace, dans la couleur de l'espace (SD-01 critère 8). */
  readonly projects?: readonly Project[];
}

/**
 * Sous-ligne d'une tâche (« 09:00 · reportée · Pro · mensuelle ») : composition par le domaine
 * (`taskLineSegments`), rendu ici (couleur de l'espace, libellés i18n). Partagée par toutes les listes
 * de tâches (Aujourd'hui, Semaine, Un jour) ; `undefined` s'il n'y a rien à afficher.
 */
export function taskSubtitle(task: Task, { spaces, showSpace, rule, projects }: TaskSubtitleOptions): ReactNode {
  const segments = taskLineSegments(task, { showSpace, hasRule: rule !== undefined, showProject: projects !== undefined });
  if (segments.length === 0) return undefined;
  const parts: ReactNode[] = [];
  for (const segment of segments) {
    if (segment.kind === 'time') parts.push(segment.time);
    else if (segment.kind === 'carried') parts.push(<span key="carried" className="ct-today__carried">{t('tasks.carriedOver')}</span>);
    else if (segment.kind === 'space') {
      const space = spaces.find((s) => s.id === segment.spaceId);
      if (space) parts.push(<span key="space" style={{ color: spaceTextColor(space.color), fontWeight: 'var(--ct-font-weight-semibold)' }}>{space.name}</span>);
    } else if (segment.kind === 'project') {
      const project = projects?.find((p) => p.id === segment.projectId);
      const space = spaces.find((s) => s.id === task.spaceId);
      if (project) parts.push(<span key="project" style={space ? { color: spaceTextColor(space.color), fontWeight: 'var(--ct-font-weight-semibold)' } : undefined}>{project.name}</span>);
    } else if (segment.kind === 'goal') {
      parts.push(
        <span key="goal" className="ct-task-goalSegment">
          <TaskGoalMark size={14} /> {t('goals.attachedWord')}
        </span>,
      );
    } else if (rule) parts.push(<span key="repeat">{formatMessageRef(recurrenceLabel(rule, task.date, 'short'))}</span>);
  }
  if (parts.length === 0) return undefined;
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && ' · '}
          {part}
        </span>
      ))}
    </>
  );
}

/**
 * Sous-ligne d'une routine (« 08:30 · Routine », en « Tout » : « 08:30 · Routine · Perso », ES-03) ; l'espace est écrit dans sa couleur.
 * Partagée par Aujourd'hui et la Semaine.
 */
export function routineSubtitle(routine: Pick<Routine, 'spaceId'>, time: string | null, { spaces, showSpace }: { readonly spaces: readonly Space[]; readonly showSpace: boolean }): ReactNode {
  const parts: ReactNode[] = [];
  if (time) parts.push(time);
  parts.push(t('today.routineLabel'));
  const space = showSpace ? spaces.find((s) => s.id === routine.spaceId) : undefined;
  // Sans espace à écrire : texte simple (« 08:30 · Routine »).
  if (!space) return parts.join(' · ');
  if (space) parts.push(<span key="space" style={{ color: spaceTextColor(space.color), fontWeight: 'var(--ct-font-weight-semibold)' }}>{space.name}</span>);
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && ' · '}
          {part}
        </span>
      ))}
    </>
  );
}
