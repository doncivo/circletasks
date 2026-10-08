import type { NotificationActionId, RawNotificationAction } from '../../domain/notificationActions';

/**
 * Source des actions de notification « Fait » et « +15 min » (N-03, ADR 0012 avenant N3.2) : port de plateforme. Sur l'iPhone, le plugin
 * Swift `notification-actions` écrit chaque action reçue (y compris app tuée) dans un fichier durable ; la source le TIRE (`drain`),
 * le cas d'usage l'inscrit dans la file locale durable, puis l'acquitte (`ack`). Hors iPhone il n'y a pas de source (`null`).
 */

/** Action proposée dans une catégorie : toujours au premier plan (l'app s'ouvre, décision du 2026-10-07). */
export interface ActionSpec {
  readonly id: NotificationActionId;
  readonly title: string;
  readonly foreground: true;
}

/** Catégorie de notification (`ct.task`, `ct.routine`, `ct.event`) et ses actions. */
export interface ActionTypeSpec {
  readonly id: string;
  readonly actions: readonly ActionSpec[];
}

/** Contenu du fichier natif, lu sans l'effacer. */
export interface ActionDrain {
  readonly entries: readonly RawNotificationAction[];
  /** Lignes physiques lues (à acquitter, illisibles comprises). */
  readonly lines: number;
  /** Lignes illisibles (comptées dans `lines`, absentes de `entries`). */
  readonly unreadable: number;
  /** Actions que le natif n'a pas pu écrire depuis le dernier acquittement. */
  readonly writeFailures: number;
}

export interface ActionSourceStatus {
  /** Le plugin est bien le délégué du centre de notifications. */
  readonly delegate: boolean;
  /** Catégories enregistrées. */
  readonly categories: number;
}

export interface NotificationActionSource {
  /** Enregistre les catégories et actions (à chaque démarrage, avant le premier envoi). */
  registerActionTypes(types: readonly ActionTypeSpec[]): Promise<void>;
  drain(): Promise<ActionDrain>;
  /** Retire du fichier les `lines` premières lignes et soustrait `writeFailures` du compteur natif. */
  ack(done: { readonly lines: number; readonly writeFailures: number }): Promise<void>;
  status(): Promise<ActionSourceStatus>;
  /** Réveil : une action vient d'être écrite. Rend le désabonnement. Jamais la source de vérité (le fichier l'est). */
  onWake(listener: () => void): Promise<() => void>;
}

export type NotificationActionSourceFailure = 'unavailable' | 'bad-response' | 'rejected';

/** Échec de la source (code seul, jamais un message système). */
export class NotificationActionSourceError extends Error {
  readonly reason: NotificationActionSourceFailure;

  constructor(reason: NotificationActionSourceFailure) {
    super(`notification action source: ${reason}`);
    this.name = 'NotificationActionSourceError';
    this.reason = reason;
  }
}
