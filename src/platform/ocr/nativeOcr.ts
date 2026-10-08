import { invoke } from '@tauri-apps/api/core';
import { OcrError, type OcrEngine, type OcrFailure, type OcrLineResult } from './types';

/** Commandes Rust (src-tauri/src/ocr/mod.rs) : les mêmes sur PC (Windows.Media.Ocr) et sur iPhone (Vision, plugin Swift appelé par Rust seul). */
export const OCR_STATUS_COMMAND = 'ocr_status';
export const OCR_RECOGNIZE_COMMAND = 'ocr_recognize';

const FAILURES: Readonly<Record<string, OcrFailure>> = {
  'ocr-language-missing': 'language-missing',
  'ocr-unsupported-format': 'unsupported-format',
  'ocr-empty-image': 'unsupported-format',
  'ocr-too-large': 'too-large',
  'ocr-dimensions-too-large': 'dimensions',
  'ocr-unavailable': 'unavailable',
};

/** Transforme l'erreur `{ code, message }` d'une commande Rust en `OcrError` (le code Rust est gardé pour l'affichage et le journal). */
export function toOcrError(error: unknown): OcrError {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  return new OcrError(FAILURES[code] ?? 'failed', error, /^[a-z-]{1,40}$/.test(code) ? code : undefined);
}

interface StatusJson {
  readonly available: boolean;
  readonly languages: string[];
  readonly reason?: string;
}

/**
 * Moteur natif par les commandes Rust : Windows.Media.Ocr (PC) ou Vision (iPhone). L'image part en corps binaire de la commande (aucun
 * fichier, aucun réseau) ; Windows ne donne pas de confiance par ligne, Vision la donne (0 à 100, déjà ramenée par Rust).
 */
export function createNativeOcr(id: 'windows' | 'vision'): OcrEngine {
  return {
    id,
    status: async () => {
      try {
        const status = await invoke<StatusJson>(OCR_STATUS_COMMAND);
        const reason = status.reason === 'language-missing' || status.reason === 'plugin-unavailable' ? status.reason : undefined;
        return { available: status.available, languages: status.languages, ...(reason ? { reason } : {}) };
      } catch {
        // `ocr_status` n'échoue jamais côté Rust : une erreur ici est une commande absente ou refusée (capability), à dire sur l'iPhone.
        return { available: false, languages: [], ...(id === 'vision' ? { reason: 'plugin-unavailable' as const } : {}) };
      }
    },
    recognize: async (image) => {
      try {
        const bytes = new Uint8Array(await image.arrayBuffer());
        const result = await invoke<{ lines: Array<{ text: string; confidence?: number }> }>(OCR_RECOGNIZE_COMMAND, bytes);
        return {
          lines: result.lines.map((line): OcrLineResult => (typeof line.confidence === 'number' ? { text: line.text, confidence: line.confidence } : { text: line.text })),
        };
      } catch (error) {
        throw toOcrError(error);
      }
    },
  };
}

/** Windows.Media.Ocr par les commandes Rust (PC). */
export function createWindowsOcr(): OcrEngine {
  return createNativeOcr('windows');
}
