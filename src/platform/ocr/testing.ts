import { OcrError, type OcrEngine, type OcrEngineId, type OcrFailure, type OcrLineResult, type RecognizeOptions } from './types';

/** Faux `OcrEngine` des tests et de l'e2e : lignes prédéfinies, pack de langue absent, échec, attente. */
export interface FakeOcr extends OcrEngine {
  available: boolean;
  lines: OcrLineResult[];
  failure: OcrFailure | null;
  /** Délai avant le résultat, pour voir « Lecture en cours ». */
  delayMs: number;
  /** Images reçues (taille et type), dans l'ordre. */
  received: Array<{ readonly size: number; readonly type: string }>;
  statusCalls: number;
  disposed: number;
  dispose(): Promise<void>;
}

export function createFakeOcr(
  initial: Partial<Pick<FakeOcr, 'available' | 'lines' | 'failure' | 'delayMs'>> & { id?: OcrEngineId } = {},
): FakeOcr {
  const fake: FakeOcr = {
    id: initial.id ?? 'fake',
    available: initial.available ?? true,
    lines: initial.lines ?? [],
    failure: initial.failure ?? null,
    delayMs: initial.delayMs ?? 0,
    received: [],
    statusCalls: 0,
    disposed: 0,
    status: () => {
      fake.statusCalls += 1;
      return Promise.resolve({ available: fake.available, languages: fake.available ? ['fr-FR'] : ['en-US'] });
    },
    recognize: async (image: Blob, options: RecognizeOptions) => {
      fake.received.push({ size: image.size, type: image.type });
      if (fake.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
      options.onProgress?.(1);
      if (fake.failure) throw new OcrError(fake.failure);
      return { lines: fake.lines };
    },
    dispose: () => {
      fake.disposed += 1;
      return Promise.resolve();
    },
  };
  return fake;
}
