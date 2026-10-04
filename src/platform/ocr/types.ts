/**
 * Contrat de la lecture de texte d'une image (Q-04, PRD sections 7 et 10). Trois moteurs derrière le même contrat : Windows.Media.Ocr
 * sur PC (commandes Rust), tesseract.js embarqué (repli PC et iPhone), Vision sur iPhone (plugin Swift, ordre 5) ; un faux pour les tests.
 * L'image n'est jamais enregistrée ni envoyée : elle passe en mémoire et est libérée à la fin de l'appel.
 */

/** Une ligne reconnue. `confidence` (0 à 100) n'existe que pour tesseract.js ; Windows.Media.Ocr n'en donne pas (décision D2). */
export interface OcrLineResult {
  readonly text: string;
  readonly confidence?: number;
}

export interface OcrEngineStatus {
  /** Vrai si le moteur peut lire du français maintenant (pack de langue présent pour Windows). */
  readonly available: boolean;
  /** Langues de reconnaissance installées (étiquettes BCP 47) ; vide si inconnu. */
  readonly languages: readonly string[];
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
  recognize(image: Blob, options: RecognizeOptions): Promise<{ readonly lines: readonly OcrLineResult[] }>;
}

export type OcrFailure = 'language-missing' | 'unsupported-format' | 'too-large' | 'dimensions' | 'unavailable' | 'failed';

export class OcrError extends Error {
  readonly reason: OcrFailure;
  constructor(reason: OcrFailure, cause?: unknown) {
    super(`Lecture du texte impossible (${reason})`, { cause });
    this.name = 'OcrError';
    this.reason = reason;
  }
}

/** Moteur principal de l'appareil (Windows, Vision) et repli embarqué (tesseract.js). */
export interface OcrEngines {
  /** Moteur natif, `null` si l'appareil n'en a pas (navigateur, iPhone avant l'ordre 5). */
  readonly primary: OcrEngine | null;
  /** Repli hors ligne, toujours proposé quand le moteur natif manque (pack de langue absent). */
  readonly fallback: OcrEngine | null;
}
