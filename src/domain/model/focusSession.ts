import type { FocusSessionRecord } from '../focusSession';
import type { FocusSessionId, ProjectId, SyncMeta } from '../types';

/**
 * Session de concentration stockée (M10, F-01, table `focus_session`, migration 0013) : l'enregistrement du domaine
 * (`FocusSessionRecord`, src/domain/focusSession.ts) plus les colonnes de synchro. `task_id` est facultatif et sans clé étrangère ;
 * le projet n'est pas stocké (celui de la tâche, ES-08).
 */
export interface FocusSession extends SyncMeta, Omit<FocusSessionRecord, 'id' | 'projectId'> {
  readonly id: FocusSessionId;
  readonly projectId: ProjectId | null;
}

/** Champs d'une nouvelle session (`ended_at` vide, `paused_sec` à 0). */
export type NewFocusSession = Pick<FocusSession, 'id' | 'taskId' | 'spaceId' | 'plannedMin' | 'startedAt'> & { readonly projectId?: ProjectId | null };

/** Champs modifiables d'une session ouverte ou à clôturer. */
export type FocusSessionPatch = Partial<Pick<FocusSession, 'plannedMin' | 'endedAt' | 'pausedSec' | 'pausedAt'>>;
