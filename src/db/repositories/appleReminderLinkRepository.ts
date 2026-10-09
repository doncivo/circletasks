import type { AppleValues, MergeField } from '../../domain/appleReminders';
import type { Hlc, IsoDateTime, TaskId } from '../../domain/types';

/** État d'un lien (ADR 0008 §10.2) : lié, création en cours (identifiant pas encore connu), suppression en cours. */
export type AppleLinkRowState = 'linked' | 'creating' | 'deleting';

/**
 * Lien local entre une tâche et un rappel EventKit (table `apple_reminder_link`, ADR 0008 §10.2) : écrit par l'iPhone seul, jamais
 * publié, vide sur le PC. Pas de clé étrangère : la tâche peut être purgée avant la fin d'une suppression.
 */
export interface AppleReminderLink {
  readonly taskId: TaskId;
  /** `calendarItemIdentifier` ; null pendant une création. */
  readonly reminderId: string | null;
  /** `calendarItemExternalIdentifier` : repli si l'identifiant local change. */
  readonly externalRef: string | null;
  readonly listId: string;
  readonly state: AppleLinkRowState;
  /** Empreinte des valeurs au dernier passage réussi ; null : inconnue (chaque différence devient un conflit). */
  readonly synced: AppleValues | null;
  /** `lastModifiedDate` vue au dernier passage. */
  readonly appleModified: IsoDateTime | null;
  /** Début d'une création ou d'une suppression (reprise après un arrêt). */
  readonly startedAt: IsoDateTime | null;
}

/**
 * Horloges (hlc) des champs d'une tâche : champ, sinon `'*'`, sinon hlc de la ligne. `external_id` (K-07) : sa date dit quand la tâche a été
 * détachée de Rappels (« Détachée de Rappels le 6 oct. »).
 */
export type TaskFieldClocks = Readonly<Record<MergeField | 'external_id', Hlc>>;

export interface AppleReminderLinkRepository {
  listAll(): Promise<AppleReminderLink[]>;
  get(taskId: TaskId): Promise<AppleReminderLink | null>;
  findByReminderId(reminderId: string): Promise<AppleReminderLink | null>;
  /** Crée ou remplace le lien de la tâche. */
  upsert(link: AppleReminderLink): Promise<void>;
  remove(taskId: TaskId): Promise<void>;
  /** Horloge de chaque champ comparé, pour les tâches demandées et encore présentes (ADR 0008 §10.5, comparaison avec `modifiedAt`). */
  fieldClocks(taskIds: readonly TaskId[]): Promise<Map<TaskId, TaskFieldClocks>>;
}
