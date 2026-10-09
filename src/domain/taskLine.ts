import type { Task } from './model';
import type { LocalTime, ProjectId, SpaceId } from './types';

/**
 * Segments de la sous-ligne d'une tâche (« 09:00 · reportée · Pro · mensuelle », Main.html,
 * PC-Semaine.html), dans l'ordre d'affichage : heure, badge « reportée » (T-06), espace (filtre « Tout »
 * seulement : en filtre Pro ou Perso il est redondant), résumé de la récurrence (T-09), rattachement à un objectif (OB-03,
 * « Perso · objectif »), badge « Rappels » d'une tâche liée à Rappels Apple (K-05 critère 13).
 * Source unique de la composition, partagée par Aujourd'hui, la Semaine et « Un jour » ; le rendu
 * (couleur de l'espace, libellés) est fait par l'interface.
 */
export type TaskLineSegment =
  | { readonly kind: 'time'; readonly time: LocalTime }
  | { readonly kind: 'carried' }
  | { readonly kind: 'space'; readonly spaceId: SpaceId }
  | { readonly kind: 'project'; readonly projectId: ProjectId }
  | { readonly kind: 'repeat' }
  | { readonly kind: 'goal' }
  /** Rappel Apple lié ou à créer (K-05 critère 13) ; `recurring` : « Récurrent dans Rappels ». */
  | { readonly kind: 'apple'; readonly recurring: boolean };

export interface TaskLineOptions {
  /** Filtre « Tout » : l'espace est affiché. */
  readonly showSpace: boolean;
  /** La règle de la série est connue : le résumé de récurrence est affiché. */
  readonly hasRule: boolean;
  /** « Un jour » (SD-01 critère 8) : le projet suit l'espace (« Pro · Mission client »), y compris sous un filtre d'espace. */
  readonly showProject?: boolean;
}

export function taskLineSegments(task: Pick<Task, 'time' | 'carriedOver' | 'spaceId'> & Partial<Pick<Task, 'goalId' | 'projectId' | 'source' | 'appleRecurring'>>, options: TaskLineOptions): TaskLineSegment[] {
  const segments: TaskLineSegment[] = [];
  if (task.time) segments.push({ kind: 'time', time: task.time });
  if (task.carriedOver) segments.push({ kind: 'carried' });
  if (options.showSpace) segments.push({ kind: 'space', spaceId: task.spaceId });
  if (options.showProject && task.projectId) segments.push({ kind: 'project', projectId: task.projectId });
  if (options.hasRule) segments.push({ kind: 'repeat' });
  if (task.goalId) segments.push({ kind: 'goal' });
  if (task.source === 'apple_reminders') segments.push({ kind: 'apple', recurring: task.appleRecurring === true });
  return segments;
}
