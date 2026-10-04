/**
 * Contrat de la dictée (Q-03, PRD sections 2 et 7). Sur PC, aucun moteur propre à l'app : la dictée Windows (Win + H) saisit dans le
 * champ. Sur iPhone, le micro du clavier iOS fait de même ; ce contrat est livré pour que le plugin Swift Speech (ordre 5, I-05) se
 * branche sans toucher aux écrans. Aucun enregistrement n'est conservé ni envoyé.
 */

export type SpeechFailure = 'permission-denied' | 'unavailable' | 'failed';

export class SpeechError extends Error {
  readonly reason: SpeechFailure;
  constructor(reason: SpeechFailure, cause?: unknown) {
    super(`Dictée impossible (${reason})`, { cause });
    this.name = 'SpeechError';
    this.reason = reason;
  }
}

export interface ListenOptions {
  /** Langue reconnue : toujours le français. */
  readonly locale: 'fr-FR';
  /** Déclenché par « Terminer » : la reconnaissance s'arrête et rend le texte reconnu jusque-là. */
  readonly stopSignal?: AbortSignal;
}

export interface SpeechRecognizer {
  /** Vrai si le bouton micro de l'app doit être affiché (jamais à l'ordre 3 : le clavier iOS suffit). */
  isAvailable(): Promise<boolean>;
  /** Écoute puis rend le texte reconnu (jamais créé tel quel : le champ sert de relecture). Rejette avec `SpeechError`. */
  listen(options: ListenOptions): Promise<string>;
}
