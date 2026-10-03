import type { DateChoice } from './dateInput';
import type { IconRef, Task, TaskPatch } from './model';
import type { ProjectId, SpaceId } from './types';

/**
 * Modification d'une tâche depuis la fiche détail (A-08) : traduction d'un choix du sélecteur de date et du
 * brouillon de la feuille « Modifier la tâche » (iPhone, Q15) en `TaskPatch`. Seuls les champs réellement
 * changés sont rendus : une modification sans effet n'écrit rien (et ne pose pas la question « cette
 * occurrence / toutes les suivantes » pour rien).
 */

/** « Un jour » (date null) ou une date avec heure optionnelle ; un retour en « date » sort la tâche de « Un jour ». */
export function patchFromDateChoice(choice: DateChoice): TaskPatch {
  if (choice.date === null) return { someday: true };
  return { someday: false, date: choice.date, time: choice.time };
}

export interface EditDraft {
  readonly title: string;
  readonly icon: IconRef | null;
  readonly choice: DateChoice;
  readonly spaceId: SpaceId;
  /** Projet choisi (ES-04) ; absent : la feuille ne le propose pas. Doit appartenir à `spaceId` (aucun si l'espace change). */
  readonly projectId?: ProjectId | null;
}

const sameIcon = (a: IconRef | null, b: IconRef | null): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Choix de date correspondant à l'état actuel d'une tâche (« Un jour » : date null). */
export function choiceOfTask(task: Pick<Task, 'date' | 'time' | 'someday'>): DateChoice {
  return task.someday || task.date === null ? { date: null, time: null } : { date: task.date, time: task.time };
}

/** Champs du brouillon qui diffèrent de la tâche (titre déjà nettoyé par l'appelant). */
export function editSheetPatch(task: Task, draft: EditDraft): TaskPatch {
  const patch: { -readonly [K in keyof TaskPatch]: TaskPatch[K] } = {};
  if (draft.title !== task.title) patch.title = draft.title;
  if (!sameIcon(draft.icon, task.icon)) patch.icon = draft.icon;
  if (draft.spaceId !== task.spaceId) {
    patch.spaceId = draft.spaceId;
    patch.projectId = draft.projectId ?? null; // un projet appartient à un espace (ES-04) : aucun si l'espace change
  } else if (draft.projectId !== undefined && draft.projectId !== task.projectId) {
    patch.projectId = draft.projectId;
  }
  const current = choiceOfTask(task);
  if (draft.choice.date !== current.date || draft.choice.time !== current.time) Object.assign(patch, patchFromDateChoice(draft.choice));
  return patch;
}
