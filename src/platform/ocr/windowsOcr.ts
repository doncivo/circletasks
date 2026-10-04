import { invoke } from '@tauri-apps/api/core';
import { OcrError, type OcrEngine, type OcrFailure, type OcrLineResult } from './types';

/** Commandes Rust (src-tauri/src/ocr/mod.rs). */
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

/** Transforme l'erreur `{ code, message }` d'une commande Rust en `OcrError`. */
export function toOcrError(error: unknown): OcrError {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  return new OcrError(FAILURES[code] ?? 'failed', error);
}

/**
 * Windows.Media.Ocr par les commandes Rust (PC). L'image part en corps binaire de la commande (aucun fichier, aucun réseau) ;
 * Windows ne donne pas de confiance par ligne.
 */
export function createWindowsOcr(): OcrEngine {
  return {
    id: 'windows',
    status: async () => {
      try {
        return await invoke<{ available: boolean; languages: string[] }>(OCR_STATUS_COMMAND);
      } catch {
        return { available: false, languages: [] };
      }
    },
    recognize: async (image) => {
      try {
        const bytes = new Uint8Array(await image.arrayBuffer());
        const result = await invoke<{ lines: Array<{ text: string }> }>(OCR_RECOGNIZE_COMMAND, bytes);
        return { lines: result.lines.map((line): OcrLineResult => ({ text: line.text })) };
      } catch (error) {
        throw toOcrError(error);
      }
    },
  };
}
