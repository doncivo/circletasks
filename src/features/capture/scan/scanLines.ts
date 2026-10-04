import type { OcrLineResult } from '../../../platform/ocr';

/**
 * Lignes lues -> tâches proposées (Q-04 critères 4, 5 et 7). Fonctions pures. Une ligne reconnue = une ligne proposée : rien n'est
 * fusionné ni coupé ; les puces, tirets, numéros et cases sont retirés, les lignes vides ou d'un seul caractère ignorées, 100 lignes au plus.
 * Une ligne douteuse est décochée et signalée (jamais par la couleur seule).
 */

/** Nombre de lignes proposées au plus (critère 5) ; le message annonce le reste. */
export const MAX_SCAN_LINES = 100;
/** Confiance sous laquelle une ligne de tesseract.js est douteuse (critère 7). */
export const MIN_CONFIDENCE = 60;

export interface ScanProposal {
  /** Identifiant stable de la ligne pendant la relecture (`line-1`…). */
  readonly id: string;
  /** Texte éditable, marque de liste retirée. */
  readonly text: string;
  /** Ligne cochée, donc créée à la validation. */
  readonly checked: boolean;
  /** Lecture douteuse : décochée et signalée. */
  readonly uncertain: boolean;
}

export interface ScanProposals {
  readonly proposals: readonly ScanProposal[];
  /** Nombre de lignes lues avant la limite de 100 (pour le message « 100 premières lignes gardées »). */
  readonly detected: number;
  readonly truncated: boolean;
}

// Marques de liste en début de ligne : puces (- – — • · * ○ ● ▪ ■ □ ☐ ☑ ✓ ✔ > »), cases ([ ], [x], [], ( )), numéros (1. 2) a) (1)).
const BULLET = /^[\s\-–—•·*○●◦▪■□☐☑☒✓✔►▶>»]+(?=\S|$)/u;
const CHECKBOX = /^(?:\[\s*[xX✓✔]?\s*\]|\(\s*[xX✓✔]?\s*\)|\{\s*\})\s*/u;
const NUMBER = /^(?:\(?\d{1,3}[.)]|\(?[a-zA-Z]\))\s+/u;
const NUMBER_ONLY = /^\(?\d{1,3}[.)]\s*$/u;

/** Retire les marques de liste en tête de ligne (répété : « - [ ] 1. Appeler » donne « Appeler »). */
export function stripListMarker(line: string): string {
  let text = line.replace(/\s+/g, ' ').trim();
  for (let guard = 0; guard < 6; guard += 1) {
    const next = text.replace(BULLET, '').replace(CHECKBOX, '').replace(NUMBER, '').trim();
    if (next === text) break;
    text = next;
  }
  return NUMBER_ONLY.test(text) ? '' : text;
}

// Caractères que l'OCR invente sur les taches, plis et traits (jamais dans une tâche écrite à la main).
const PARASITIC = /[|\\_~^<>{}[\]=¬¦§¨`´¤£¢¥]/u;
const LETTER = /\p{L}/gu;

/** Une ligne est douteuse si elle a moins de 3 lettres, un « ? », des caractères parasites, ou une confiance < 60 % (critère 7). */
export function isUncertain(text: string, confidence?: number): boolean {
  const letters = text.match(LETTER)?.length ?? 0;
  if (letters < 3) return true;
  if (text.includes('?')) return true;
  if (PARASITIC.test(text)) return true;
  // Majorité de signes sur une courte ligne (« -.,;: ab ») : bruit.
  const signs = [...text].filter((char) => !/[\p{L}\p{N}\s]/u.test(char)).length;
  if (signs > 0 && signs * 3 > text.length) return true;
  return confidence !== undefined && confidence < MIN_CONFIDENCE;
}

/** Lignes lues -> propositions. Les lignes vides ou d'un seul caractère, une fois la marque retirée, sont ignorées (critère 5). */
export function scanLinesToProposals(lines: readonly OcrLineResult[]): ScanProposals {
  const kept: Array<{ text: string; confidence: number | undefined }> = [];
  for (const line of lines) {
    const text = stripListMarker(line.text);
    if ([...text].length <= 1) continue;
    kept.push({ text, confidence: line.confidence });
  }
  const proposals = kept.slice(0, MAX_SCAN_LINES).map(({ text, confidence }, index): ScanProposal => {
    const uncertain = isUncertain(text, confidence);
    return { id: `line-${index + 1}`, text, checked: !uncertain, uncertain };
  });
  return { proposals, detected: kept.length, truncated: kept.length > MAX_SCAN_LINES };
}
