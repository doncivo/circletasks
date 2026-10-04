/**
 * Contrats de la plateforme pour le Focus (M10, F-01 à F-04). Seule src/platform connaît Tauri ; les features reçoivent ces
 * abstractions par le conteneur (`null` hors PC : navigateur, Playwright, iPhone, tests).
 */

/** Phase affichée par l'écran de session. */
export type FocusPhase = 'running' | 'paused' | 'ended';

/**
 * Photographie de la session envoyée à la mini-fenêtre PC (D4 : l'état vit dans la fenêtre principale, la mini-fenêtre est une vue
 * pilotée par événements). Elle porte des HORODATAGES, jamais un temps restant : la vue recalcule l'affichage avec sa propre horloge,
 * donc elle reste juste même si aucun message n'arrive pendant une veille.
 */
export interface FocusWindowState {
  readonly phase: FocusPhase;
  readonly session: {
    readonly id: string;
    readonly plannedMin: number | null;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly pausedSec: number;
    readonly pausedAt: string | null;
  };
  /** Titre de la tâche ; null si elle a disparu (la session continue, F-01 critère 10). */
  readonly title: string | null;
  /** Heure de la tâche déjà formatée (« 09:00 »), null sans heure. */
  readonly time: string | null;
  readonly spaceName: string;
  /** « Terminer la tâche » est proposé (la tâche existe et n'est pas terminée). */
  readonly canFinishTask: boolean;
  /** Pied de l'écran (F-03) : concentration du jour, toutes sessions terminées. */
  readonly today: { readonly minutes: number; readonly sessions: number };
  /** Son de fin (F-04) : `nonce` change à chaque fin à signaler ; la vue joue le son une seule fois par nonce si `enabled`. */
  readonly sound: { readonly enabled: boolean; readonly nonce: number };
  /** Minutes enregistrées de la session terminée (phase `ended`). */
  readonly endedMinutes: number;
  /** Premier jour / format d'heure : les textes sont déjà formatés côté fenêtre principale. */
  readonly locale: 'fr' | 'en';
}

/** Ordres envoyés par la mini-fenêtre à la fenêtre principale. */
export type FocusWindowAction =
  | { readonly type: 'ready' }
  /** La vue constate que le terme est atteint (le minuteur de la fenêtre principale peut être ralenti quand elle est masquée). */
  | { readonly type: 'elapsed' }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'duration'; readonly minutes: number | null }
  | { readonly type: 'stop' }
  | { readonly type: 'finishTask' }
  | { readonly type: 'another' }
  | { readonly type: 'dismiss' }
  | { readonly type: 'moved'; readonly x: number; readonly y: number };

/** Position mémorisée de la mini-fenêtre (pixels physiques). */
export interface FocusWindowPosition {
  readonly x: number;
  readonly y: number;
}

/** Côté fenêtre principale : ouvre, pilote et ferme la mini-fenêtre toujours au premier plan (F-01 critère 3). */
export interface FocusWindowPlatform {
  /** Ouvre la mini-fenêtre (340 × 460, premier plan, hors barre des tâches) ou, si elle existe, la ramène au premier plan. */
  open(position: FocusWindowPosition | null): Promise<void>;
  /** Ramène la fenêtre existante au premier plan (F-01 critère 6) ; sans effet si elle est fermée. */
  bringToFront(): Promise<void>;
  /** Ferme la mini-fenêtre ; sans effet si elle est fermée. */
  close(): Promise<void>;
  /** Envoie l'état courant ; mémorisé et renvoyé quand la fenêtre signale `ready`. */
  publish(state: FocusWindowState): Promise<void>;
  /** Ordres de la mini-fenêtre. Renvoie la fonction de désabonnement. */
  onAction(handler: (action: FocusWindowAction) => void): Promise<() => void>;
}

/** Côté mini-fenêtre : reçoit l'état, envoie des ordres, signale la fermeture demandée (croix du système). */
export interface FocusWindowClient {
  onState(handler: (state: FocusWindowState) => void): Promise<() => void>;
  send(action: FocusWindowAction): Promise<void>;
  /** La croix de la barre de titre a été pressée : la fermeture est suspendue, la vue demande confirmation. */
  onCloseRequested(handler: () => void): Promise<() => void>;
  /** Position de la fenêtre déplacée par l'utilisateur. */
  onMoved(handler: (position: FocusWindowPosition) => void): Promise<() => void>;
}

/**
 * Notification locale de fin de session (iPhone, ordre 5 : N-01, N-03, N-05). Seul le contrat est livré à l'ordre 3 : l'envoi réel
 * viendra d'un plugin Swift ; ici une implémentation vide et un faux testé (F-04 critère 8).
 */
export interface FocusEndScheduler {
  /** Planifie (ou remplace) la notification de fin de cette session à `fireAt`. */
  schedule(sessionId: string, fireAt: Date, title: string): Promise<void>;
  /** Annule la notification de cette session ; sans effet si aucune n'est planifiée. */
  cancel(sessionId: string): Promise<void>;
}

/** Son de fin de session (carillon embarqué, volume système). */
export interface SoundPlayer {
  play(): Promise<void>;
}
