import { detectOs, detectRuntime, type OsFamily, type Runtime } from '../runtime';
import { createTesseractOcr } from './tesseractOcr';
import { createFakeOcr } from './testing';
import type { OcrEngine, OcrEngines } from './types';
import { createWindowsOcr } from './windowsOcr';

export { OcrError, type OcrEngine, type OcrEngineId, type OcrEngineStatus, type OcrEngines, type OcrFailure, type OcrLineResult, type RecognizeOptions } from './types';
export { BUNDLED_TESSERACT_PATHS, createTesseractOcr, linesOfPage, type TesseractPaths } from './tesseractOcr';
export { createWindowsOcr, toOcrError } from './windowsOcr';

/** Moteurs de l'appareil. Une instance suffit : le worker de tesseract.js est libéré par `dispose()` à la fermeture de l'écran de scan. */
export interface OcrService extends OcrEngines {
  /** Libère le worker du repli (mémoire), sans effet s'il n'a pas servi. */
  dispose(): Promise<void>;
}

interface FakeOcrHook {
  readonly lines?: ReadonlyArray<{ readonly text: string; readonly confidence?: number }>;
  readonly packMissing?: boolean;
  readonly delayMs?: number;
  readonly failure?: 'failed';
}

/**
 * Moteurs disponibles : PC Windows = Windows.Media.Ocr (fr-FR) puis repli tesseract.js ; iPhone et navigateur = tesseract.js (Vision
 * remplacera le moteur natif à l'ordre 5 derrière le même contrat). En développement et en test seulement, `globalThis.__CT_FAKE_OCR__`
 * remplace les moteurs par un faux (e2e Playwright : « faux moteur »).
 */
export function openOcrService(runtime: Runtime = detectRuntime(), os: OsFamily = detectOs()): OcrService {
  const fakeHook = import.meta.env.DEV ? ((globalThis as Record<string, unknown>)['__CT_FAKE_OCR__'] as FakeOcrHook | undefined) : undefined;
  if (fakeHook) {
    const lines = (fakeHook.lines ?? []).map((line) => ({ ...line }));
    const fakeOptions = { lines, delayMs: fakeHook.delayMs ?? 0, ...(fakeHook.failure ? { failure: fakeHook.failure } : {}) };
    const fake = createFakeOcr(fakeOptions);
    // Journal de test : taille, type et dimensions de chaque image reçue (l'e2e vérifie la réduction à 2 000 px).
    const log: Array<{ type: string; size: number; width: number; height: number }> = [];
    (globalThis as Record<string, unknown>)['__CT_FAKE_OCR_LOG__'] = log;
    const read = fake.recognize;
    fake.recognize = async (image, options) => {
      const bitmap = await createImageBitmap(image).catch(() => null);
      log.push({ type: image.type, size: image.size, width: bitmap?.width ?? 0, height: bitmap?.height ?? 0 });
      bitmap?.close();
      return read(image, options);
    };
    if (fakeHook.packMissing) {
      const missing = createFakeOcr({ available: false, id: 'windows' });
      return { primary: missing, fallback: fake, dispose: () => Promise.resolve() };
    }
    return { primary: null, fallback: fake, dispose: () => Promise.resolve() };
  }
  const fallback = createTesseractOcr();
  const primary: OcrEngine | null = runtime === 'tauri' && os === 'windows' ? createWindowsOcr() : null;
  return { primary, fallback, dispose: () => fallback.dispose() };
}
