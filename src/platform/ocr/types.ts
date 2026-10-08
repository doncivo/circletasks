/**
 * Contrat de la lecture de texte d'une image (Q-04, PRD sections 7 et 10). Trois moteurs derrière le même contrat : Windows.Media.Ocr
 * sur PC (commandes Rust), Vision sur iPhone (plugin Swift appelé par Rust, CAP-IOS-01), tesseract.js embarqué (repli choisi, PC et iPhone) ; un faux pour les tests.
 * L'image n'est jamais enregistrée ni envoyée : elle passe en mémoire et est libérée à la fin de l'appel.
 */

/** Une ligne reconnue. `confidence` (0 à 100) existe pour Vision et tesseract.js ; Windows.Media.Ocr n'en donne pas (décision D2). */
export interface OcrLineResult {
  readonly text: string;
  readonly confidence?: number;
}

export interface OcrEngineStatus {
  /** Vrai si le moteur peut lire du français maintenant (pack de langue présent pour Windows). */
  readonly available: boolean;
  /** Langues de reconnaissance installées (étiquettes BCP 47) ; vide si inconnu. */
  readonly languages: readonly string[];
  /** Pourquoi le moteur natif est indisponible (iPhone, Vision) : français absent, ou plugin absent, refusé ou muet. */
  readonly reason?: 'language-missing' | 'plugin-unavailable';
  /** La suppression des copies temporaires des photos a échoué (iPhone) : dit à l'utilisateur, jamais silencieux. */
  readonly cleanupFailed?: boolean;
}

export interface RecognizeOptions {
  /** Langue du texte : toujours le français. */
  readonly lang: 'fra';
  /** Avancement de la lecture (0 à 1), si le moteur le connaît. */
  readonly onProgress?: (progress: number) => void;
}

export type OcrEngineId = 'windows' | 'tesseract' | 'vision' | 'fake';

export interface OcrEngine {
  readonly id: OcrEngineId;
  status(): Promise<OcrEngineStatus>;
  /** Lit l'image ; rejette avec `OcrError`. */
  recognize(image: Blob, options: RecognizeOptions): Promise<{ readonly lines: readonly OcrLineResult[]; /** Le moteur a rendu plus de lignes qu'il n'en a transmis (Vision : 500 au plus, de haut en bas). */ readonly truncated?: boolean }>;
}

export type OcrFailure = 'language-missing' | 'unsupported-format' | 'too-large' | 'dimensions' | 'unavailable' | 'timeout' | 'busy' | 'failed';

export class OcrError extends Error {
  readonly reason: OcrFailure;
  /** Code de la commande Rust (`ocr-engine`, `ocr-unavailable`…), affiché et journalisé ; jamais un texte reconnu. */
  readonly code?: string;
  constructor(reason: OcrFailure, cause?: unknown, code?: string) {
    super(`Lecture du texte impossible (${reason})`, { cause });
    this.name = 'OcrError';
    this.reason = reason;
    if (code !== undefined) this.code = code;
  }
}

/** Moteur principal de l'appareil (Windows, Vision) et repli embarqué (tesseract.js). */
export interface OcrEngines {
  /** Moteur natif, `null` si l'appareil n'en a pas (navigateur). */
  readonly primary: OcrEngine | null;
  /** Repli hors ligne, toujours proposé quand le moteur natif manque (pack de langue absent). */
  readonly fallback: OcrEngine | null;
}
