import type { IsoDateTime } from '../../domain/types';

/**
 * Ports de l'expiration de la signature SideStore (I-02, ADR 0013 §3.2). Le port de lecture ne rejette jamais : un échec est une valeur,
 * affichée par la feature (aucun échec silencieux).
 */

/** `unavailable` : commande absente ou refusée par la capability (l'app iPhone installée n'en dispose pas). */
export type SigningReadFailure = 'profile-missing' | 'profile-unreadable' | 'unavailable';

export type SigningRead =
  | { readonly ok: true; readonly expiresAt: IsoDateTime; readonly issuedAt: IsoDateTime | null }
  | { readonly ok: false; readonly code: SigningReadFailure };

export interface SigningSource {
  /** Vrai sur l'iPhone installé seulement : faux sur le PC et dans le navigateur (ligne « À propos » absente, aucune alerte). */
  readonly supported: boolean;
  read(): Promise<SigningRead>;
}

/** Demande d'envoi de l'alerte (identifiant réservé 2) : l'instant est absolu, converti en heure murale du fuseau par l'adaptateur. */
export interface SigningAlertRequest {
  readonly instant: number;
  readonly zone: string | null;
  readonly title: string;
  readonly body: string;
}

/**
 * Alerte d'expiration (identifiant de notification réservé 2, ADR 0012 avenant lot M). Les trois méthodes rejettent
 * (`NotificationSchedulerError`) : la feature les attrape et en fait un état visible.
 */
export interface SigningAlert {
  /** Envoie (ou remplace, même identifiant) l'alerte. */
  schedule(request: SigningAlertRequest): Promise<void>;
  /** Retire l'alerte. */
  cancel(): Promise<void>;
  /** Vrai si iOS a l'identifiant 2 en attente. */
  isPending(): Promise<boolean>;
}

export interface SigningPlatform {
  readonly source: SigningSource;
  readonly alert: SigningAlert;
}
