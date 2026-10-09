/**
 * Contrat de la dictée (Q-03, CAP-IOS-01, I-05, PRD sections 2 et 7). Sur PC, aucun moteur propre à l'app : la dictée Windows (Win + H)
 * saisit dans le champ. Sur iPhone, le plugin Swift `speech` (ADR 0015) dicte en français SUR L'APPAREIL (aucun audio n'est envoyé) ;
 * le micro du clavier iOS reste la voie de secours. Aucun enregistrement n'est conservé ni envoyé.
 */
export type SpeechFailure = 'permission-denied' | 'unavailable' | 'failed' | 'on-device-unavailable' | 'busy';

/** État d'une autorisation lu du système (`unknown` : valeur inattendue ou plugin muet, affichée avec son code). */
export type SpeechPermissionState = 'granted' | 'denied' | 'restricted' | 'prompt' | 'unknown';

export interface SpeechPermissions {
  readonly microphone: SpeechPermissionState;
  readonly speechRecognition: SpeechPermissionState;
}

/** Cause de la fin d'une écoute. */
export type SpeechStopReason = 'user' | 'time-limit' | 'background' | 'interrupted' | 'ended';

export interface SpeechErrorDetails {
  /** Autorisation refusée (`permission-denied` seulement). */
  readonly permission?: 'microphone' | 'speech-recognition';
  /** Code de la commande Rust (affiché et journalisé, jamais un texte reconnu). */
  readonly code?: string;
}

export class SpeechError extends Error {
  readonly reason: SpeechFailure;
  readonly permission?: 'microphone' | 'speech-recognition';
  readonly code?: string;
  constructor(reason: SpeechFailure, cause?: unknown, details: SpeechErrorDetails = {}) {
    super(`Dictée impossible (${reason})`, { cause });
    this.name = 'SpeechError';
    this.reason = reason;
    if (details.permission !== undefined) this.permission = details.permission;
    if (details.code !== undefined) this.code = details.code;
  }
}

export interface ListenOptions {
  /** Langue reconnue : toujours le français. */
  readonly locale: 'fr-FR';
  /** Déclenché par « Terminer » (ou le passage en arrière-plan, le verrou) : la reconnaissance s'arrête et rend le texte reconnu jusque-là. */
  readonly stopSignal?: AbortSignal;
  /** Cause de la fin d'écoute, appelée avant la résolution de `listen`. */
  readonly onStopped?: (reason: SpeechStopReason) => void;
}

export interface SpeechRecognizer {
  /** Vrai si le bouton micro de l'app doit être affiché (iPhone avec le plugin Speech ; jamais sur PC où Win + H suffit). */
  isAvailable(): Promise<boolean>;
  /** Écoute puis rend le texte reconnu (jamais créé tel quel : le champ sert de relecture). Rejette avec `SpeechError`. */
  listen(options: ListenOptions): Promise<string>;
  /** État des deux autorisations, relu du système sans rien demander ; absent = aucune autorisation à demander (PC, web). */
  permissions?(): Promise<SpeechPermissions>;
  /** Demande le micro puis la reconnaissance vocale ; appelée seulement depuis « Continuer » (I-05), jamais au démarrage. */
  requestPermissions?(): Promise<SpeechPermissions>;
  /** Vrai si le modèle français hors ligne est présent, faux s'il manque ; `undefined` si l'état n'a pas pu être lu (jamais faux dans ce cas). */
  onDeviceReady?(): Promise<boolean | undefined>;
  /** Disponibilité avec, si le service est indisponible, le code à dire à l'utilisateur ; absent : seul `isAvailable` existe (aucun code à dire). */
  availability?(): Promise<{ readonly available: boolean; readonly code?: string }>;
}
