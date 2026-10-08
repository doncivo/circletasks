import type { NewReminder, Reminder, ReminderTarget } from '../../domain/model';
import type { Hlc, IsoDateTime, LocalDateTime, ReminderId } from '../../domain/types';

/**
 * Rappels (M5). Ordre 1 : données (N-02). L'envoi (N-01, N-05 à N-07) relève de
 * l'ordre 5 sur l'iPhone ; le PC ne lit ces données que pour l'avertissement N-07.
 */
/**
 * Marque de la suppression d'un élément (son `deletedAt` et son `hlc` d'écriture) : seuls les
 * rappels supprimés AVEC l'élément (même `deleted_at`, écrits après lui) sont restaurés ; ceux
 * retirés plus tôt par l'utilisateur (N-02) restent supprimés.
 */
export interface ReminderDeletionMark {
  readonly deletedAt: IsoDateTime;
  readonly hlc: Hlc;
}

export interface ReminderRepository {
  /** N-03 : un rappel par identifiant, SUPPRIMÉ COMPRIS (une action de notification peut viser un rappel retiré depuis) ; null s'il n'existe pas. */
  getById(id: ReminderId): Promise<Reminder | null>;
  /** Rappels d'un élément, triés par `fire_at`. */
  listForTarget(target: ReminderTarget): Promise<Reminder[]>;
  /**
   * N-02 : remplace l'ensemble des rappels d'un élément. Les rappels existants de
   * même `offsetMin` sont conservés (fire_at mis à jour si besoin), les autres sont
   * supprimés logiquement, les nouveaux insérés. Une seule transaction.
   */
  replaceForTarget(target: ReminderTarget, reminders: readonly NewReminder[]): Promise<Reminder[]>;
  /**
   * P-07 : insère en lot (paquets, une instruction par paquet) des rappels d'éléments NEUFS (aucun rappel existant à remplacer), un tampon
   * distinct par ligne. Renvoie le nombre de rappels écrits.
   */
  createMany(reminders: readonly NewReminder[]): Promise<number>;
  /**
   * P-07 : supprime logiquement en lot, par paquets, les rappels vivants de ces éléments (un seul type de cible), un tampon distinct par
   * ligne. Renvoie le nombre de rappels supprimés.
   */
  softDeleteForTargets(targetType: ReminderTarget['type'], targetIds: readonly string[]): Promise<number>;
  /** Suppression de l'élément ciblé (T-08) : rappels supprimés avec lui. */
  softDeleteForTarget(target: ReminderTarget, deletedAt?: IsoDateTime): Promise<Reminder[]>;
  /** Restauration de l'élément ciblé : seuls les rappels supprimés avec lui (même marque) sont restaurés. */
  restoreForTarget(target: ReminderTarget, deletion: ReminderDeletionMark): Promise<Reminder[]>;
  /** Fenêtre glissante (ordre 5) et avertissement N-07 : `from` inclus, `to` exclu. */
  listBetween(from: LocalDateTime, to: LocalDateTime): Promise<Reminder[]>;
  /** N-01 : tous les rappels vivants (le planificateur recalcule les échéances depuis les cibles, `fire_at` n'est pas lu). */
  listLive(): Promise<Reminder[]>;
  /** Ordre 5 (iPhone uniquement). */
  markDelivered(id: ReminderId): Promise<Reminder>;
}
