import type { NewReminder, Reminder, ReminderTarget } from '../../domain/model';
import type { LocalDateTime, ReminderId } from '../../domain/types';

/**
 * Rappels (M5). Ordre 1 : données (N-02). L'envoi (N-01, N-05 à N-07) relève de
 * l'ordre 5 sur l'iPhone ; le PC ne lit ces données que pour l'avertissement N-07.
 */
export interface ReminderRepository {
  /** Rappels d'un élément, triés par `fire_at`. */
  listForTarget(target: ReminderTarget): Promise<Reminder[]>;
  /**
   * N-02 : remplace l'ensemble des rappels d'un élément. Les rappels existants de
   * même `offsetMin` sont conservés (fire_at mis à jour si besoin), les autres sont
   * supprimés logiquement, les nouveaux insérés. Une seule transaction.
   */
  replaceForTarget(target: ReminderTarget, reminders: readonly NewReminder[]): Promise<Reminder[]>;
  /** Suppression de l'élément ciblé (T-08) : rappels supprimés avec lui. */
  softDeleteForTarget(target: ReminderTarget): Promise<Reminder[]>;
  /** Restauration de l'élément ciblé : rappels supprimés avec lui restaurés. */
  restoreForTarget(target: ReminderTarget): Promise<Reminder[]>;
  /** Fenêtre glissante (ordre 5) et avertissement N-07 : `from` inclus, `to` exclu. */
  listBetween(from: LocalDateTime, to: LocalDateTime): Promise<Reminder[]>;
  /** Ordre 5 (iPhone uniquement). */
  markDelivered(id: ReminderId): Promise<Reminder>;
}
