import { OcrError, type OcrEngine, type OcrLineResult } from './types';

/**
 * Chemins du repli tesseract.js (Q-04 décision D3). Tout est local : worker, noyau WebAssembly et données `fra` (modèle « best » quantifié,
 * 0,7 Mo) sont servis par l'app (plugin Vite `ocrAssets`, dossier `ocr/` du paquet), jamais téléchargés d'Internet.
 */
export interface TesseractPaths {
  readonly workerPath: string;
  readonly corePath: string;
  readonly langPath: string;
}

export const BUNDLED_TESSERACT_PATHS: TesseractPaths = {
  workerPath: '/ocr/worker.min.js',
  corePath: '/ocr/tesseract-core-simd-lstm.wasm.js',
  langPath: '/ocr/lang',
};

export interface TesseractOcrOptions {
  readonly paths?: TesseractPaths;
  /** Adapte l'image à l'entrée du worker (navigateur : le `Blob` tel quel ; Node, pour les tests : un `Buffer`). */
  readonly toInput?: (image: Blob) => Promise<unknown>;
}

interface WorkerLike {
  recognize(image: unknown, options?: object, output?: object): Promise<{ data: { blocks?: Array<{ paragraphs: Array<{ lines: Array<{ text: string; confidence: number }> }> }> | null; text?: string } }>;
  terminate(): Promise<unknown>;
}

/** Lignes d'une page : une ligne reconnue = une entrée, confiance de 0 à 100. À défaut de blocs, le texte brut est coupé par ligne. */
export function linesOfPage(page: {
  blocks?: Array<{ paragraphs: Array<{ lines: Array<{ text: string; confidence: number }> }> }> | null;
  text?: string;
}): OcrLineResult[] {
  const fromBlocks = (page.blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines));
  if (fromBlocks.length > 0) return fromBlocks.map((line) => ({ text: line.text.replace(/\s+/g, ' ').trim(), confidence: line.confidence })).filter((line) => line.text !== '');
  return (page.text ?? '')
    .split(/\r?\n/)
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter((text) => text !== '')
    .map((text) => ({ text }));
}

/** Absolu : un worker résout ses chemins relatifs par rapport à son propre script, pas à la page. */
function absolute(path: string): string {
  const base = globalThis.location?.href;
  return base ? new URL(path, base).href : path;
}

/**
 * Repli tesseract.js, hors ligne (Q-04 décision D3, PRD section 7). Chargé à la demande au premier appel (import dynamique) ; le worker est
 * conservé entre deux lectures puis libéré par `dispose()` à la fermeture de l'écran. Aucun cache disque (`cacheMethod: 'none'`).
 */
export function createTesseractOcr(options: TesseractOcrOptions = {}): OcrEngine & { dispose(): Promise<void> } {
  const paths = options.paths ?? BUNDLED_TESSERACT_PATHS;
  let worker: Promise<WorkerLike> | null = null;
  let onProgress: ((progress: number) => void) | undefined;

  const start = (): Promise<WorkerLike> => {
    worker ??= import('tesseract.js').then(async ({ createWorker }) => {
      const created = await createWorker('fra', 1, {
        workerPath: absolute(paths.workerPath),
        corePath: absolute(paths.corePath),
        langPath: absolute(paths.langPath),
        gzip: true,
        cacheMethod: 'none',
        workerBlobURL: false,
        // L'échec d'une lecture rejette déjà la promesse de `recognize` ; sans gestionnaire, tesseract.js lèverait en plus une exception non gérée.
        errorHandler: () => undefined,
        logger: (message) => {
          if (message.status === 'recognizing text') onProgress?.(message.progress);
        },
      });
      return created as unknown as WorkerLike;
    });
    // Un échec de chargement ne reste pas en mémoire : la lecture suivante réessaie.
    worker.catch(() => {
      worker = null;
    });
    return worker;
  };

  return {
    id: 'tesseract',
    status: () => {
      const supported = typeof WebAssembly === 'object' && (typeof Worker !== 'undefined' || typeof process !== 'undefined');
      return Promise.resolve({ available: supported, languages: supported ? ['fra'] : [] });
    },
    recognize: async (image, recognizeOptions) => {
      try {
        const engine = await start();
        onProgress = recognizeOptions.onProgress;
        const input = options.toInput ? await options.toInput(image) : image;
        const { data } = await engine.recognize(input, {}, { blocks: true, text: true });
        return { lines: linesOfPage(data) };
      } catch (error) {
        throw new OcrError('failed', error);
      } finally {
        onProgress = undefined;
      }
    },
    dispose: async () => {
      const current = worker;
      worker = null;
      if (!current) return;
      try {
        await (await current).terminate();
      } catch {
        // Worker déjà arrêté : rien à libérer.
      }
    },
  };
}
