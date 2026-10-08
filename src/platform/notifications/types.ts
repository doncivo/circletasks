import type { LocalDateTime } from '../../domain/types';

/**
 * Contrat de planification des notifications de rappel (N-TECH-01, ADR 0012 section 2). Le contrat ne connaît ni instant ni fuseau :
 * `fireAt` est une heure locale flottante, convertie en instant par l'adaptateur réel (N-01) au moment de l'envoi. Le PC n'émet
 * aucun rappel : il garde l'implémentation vide (`unavailable.ts`).
 */

/** Plafond iOS des notifications locales en attente. */
export const NOTIFICATION_LIMIT = 64;

/** `snooze` : répétition « +15 min » de N-03 (place réservée par l'avenant N1, non branchée au lot N1 tant que N-03 est en attente). */
export type NotificationKind = 'task' | 'routine' | 'event' | 'recap' | 'snooze';
export const NOTIFICATION_KINDS: readonly NotificationKind[] = ['task', 'routine', 'event', 'recap', 'snooze'];
/** Actions proposées par la notification (N-03) ; absente pour un récapitulatif et la fin de Focus. */
export type NotificationCategory = 'task' | 'routine' | 'event';

export interface NotificationRequest {
  /** Identifiant stable produit par le domaine (`task:{reminderId}`, `recap:evening:{jour}`…). */
  readonly id: string;
  /** Échéance EFFECTIVE (plages silencieuses déjà appliquées), heure locale flottante. */
  readonly fireAt: LocalDateTime;
  readonly title: string;
  readonly body: string;
  readonly kind: NotificationKind;
  readonly category?: NotificationCategory;
}

/** Ce que `replace` a fait : un remplacement d'un même identifiant compte une fois dans `scheduled`. */
export interface ReplaceReport {
  readonly scheduled: number;
  readonly cancelled: number;
  readonly kept: number;
}

export type NotificationAvailability = 'available' | 'unavailable';
export type NotificationPermission = 'granted' | 'denied' | 'undetermined';

export type NotificationFailure =
  // Refus avant tout effet.
  | 'duplicate-id'
  | 'over-limit'
  | 'invalid-request'
  // État du système.
  | 'unavailable'
  | 'permission-denied'
  // Échec pendant ou après l'envoi (adaptateur réel).
  | 'schedule-failed'
  | 'verify-failed'
  // Envoi réussi mais registre non enregistré (avenant N1.2).
  | 'ledger-failed';

/**
 * Échec de `replace`, jamais silencieux : la raison et les identifiants en cause sont lus par N-01 pour l'état visible (bandeau,
 * Réglages > Rappels). Le journal n'en garde que le code et les nombres, jamais un titre ni un texte de rappel.
 */
export class NotificationSchedulerError extends Error {
  readonly reason: NotificationFailure;
  /** Identifiants en cause : doublons, refusés, en trop, manquants. */
  readonly ids: readonly string[];
  /** Ce qui a été fait avant l'échec (`schedule-failed`, `verify-failed`), sinon null. */
  readonly partial: ReplaceReport | null;

  constructor(reason: NotificationFailure, ids: readonly string[] = [], partial: ReplaceReport | null = null) {
    super(`notification scheduler: ${reason}`);
    this.name = 'NotificationSchedulerError';
    this.reason = reason;
    this.ids = ids;
    this.partial = partial;
  }
}

export interface NotificationScheduler {
  availability(): Promise<NotificationAvailability>;
  permission(): Promise<NotificationPermission>;
  requestPermission(): Promise<NotificationPermission>;
  /**
   * Remplace tout le plan, par différence, de façon idempotente. Valide d'abord (aucun effet en cas de refus) : `invalid-request`,
   * `duplicate-id`, `over-limit`. Le plafond est appliqué par le planificateur du domaine, jamais en silence ici.
   */
  replace(requests: readonly NotificationRequest[]): Promise<ReplaceReport>;
  /** Annule les notifications du plan seulement (jamais la fin de session Focus). */
  cancelAll(): Promise<void>;
  /** La dernière liste acceptée, triée par échéance puis identifiant. */
  pending(): Promise<readonly NotificationRequest[]>;
  /** Notifications en attente hors plan (identifiants 1 à 65 535 : fin de Focus), comptées dans les 64 par N-01. */
  reservedCount(): Promise<number>;
}
