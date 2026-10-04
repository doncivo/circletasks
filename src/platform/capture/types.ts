import type { QuickProject, QuickSpace } from '../../domain/quickInput';
import type { SpaceFilter } from '../../domain/types';
import type { FirstWeekday } from '../../domain/week';

/**
 * Contrat de la capture rapide PC (Q-01, ADR 0006) : deux fenêtres, une seule écrit dans la base (la principale).
 * Seule src/platform connaît Tauri ; les features reçoivent un pont.
 */

/** Ce que la mini-fenêtre sait de l'application, pour les suggestions et l'aperçu (elle n'ouvre jamais la base). */
export interface CaptureContextSnapshot {
  readonly spaces: readonly QuickSpace[];
  readonly projects: readonly QuickProject[];
  /** Filtre Pro / Perso / Tout de la fenêtre principale : sert à l'espace par défaut (ES-02). */
  readonly spaceFilter: SpaceFilter;
  readonly firstWeekday: FirstWeekday;
}

/** Texte à créer (`capture:submit`) ; `ignored` : marques retirées de l'aperçu (elles restent du texte). */
export interface CaptureSubmit {
  readonly requestId: string;
  readonly text: string;
  readonly ignored: readonly string[];
}

export type CaptureError = 'title-empty' | 'no-space' | 'failed';

/** Réponse de la fenêtre principale (`capture:done`). */
export type CaptureOutcome =
  | { readonly requestId: string; readonly ok: true; readonly title: string }
  | { readonly requestId: string; readonly ok: false; readonly error: CaptureError };

export type CaptureReply = { readonly ok: true; readonly title: string } | { readonly ok: false; readonly error: CaptureError };

export type Unlisten = () => void;

/** Côté mini-fenêtre. */
export interface CaptureWindowBridge {
  /** La fenêtre vient d'être montrée. */
  onShown(handler: () => void): Promise<Unlisten>;
  /** La fenêtre a perdu le focus. */
  onBlurred(handler: () => void): Promise<Unlisten>;
  /** Contexte reçu de la fenêtre principale. */
  onContext(handler: (context: CaptureContextSnapshot) => void): Promise<Unlisten>;
  /** Demande un contexte à jour (réponse par `onContext`). */
  requestContext(): Promise<void>;
  /** Envoie le texte à la fenêtre principale et attend sa réponse (échec `failed` au bout de 8 s). Ne rejette jamais. */
  submit(request: Omit<CaptureSubmit, 'requestId'>): Promise<CaptureReply>;
  /** Cache la mini-fenêtre (le focus revient à l'application précédente). Ne rejette jamais. */
  hide(): Promise<void>;
  /** Agrandit la fenêtre pour la liste de suggestions (hauteur logique). Ne rejette jamais. */
  resize(height: number): Promise<void>;
}

/** Côté fenêtre principale, seule à écrire dans la base. */
export interface CaptureMainBridge {
  /** Traite chaque `capture:submit` ; la réponse du gestionnaire repart vers la mini-fenêtre. */
  onSubmit(handler: (request: CaptureSubmit) => Promise<CaptureReply>): Promise<Unlisten>;
  /** Pousse le contexte vers la mini-fenêtre. */
  publishContext(context: CaptureContextSnapshot): Promise<void>;
  /** La mini-fenêtre demande un contexte à jour. */
  onContextRequest(handler: () => void): Promise<Unlisten>;
}

/** Transport de messages entre les deux fenêtres (Tauri : événements ; navigateur de développement : BroadcastChannel). */
export interface CaptureTransport {
  emit(target: string, event: string, payload: unknown): Promise<void>;
  listen(event: string, handler: (payload: unknown) => void): Promise<Unlisten>;
  /** Commande de la mini-fenêtre (cacher, redimensionner). */
  invoke(command: string, args?: Record<string, unknown>): Promise<void>;
}
