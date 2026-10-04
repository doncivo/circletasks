import { SpeechError, type ListenOptions, type SpeechFailure, type SpeechRecognizer } from './types';

/** Faux `SpeechRecognizer` des tests : texte prédéfini, refus de permission possible, attente de « Terminer » possible. */
export interface FakeSpeech extends SpeechRecognizer {
  available: boolean;
  /** Texte rendu par `listen`. */
  transcript: string;
  /** Cause d'un échec à la prochaine écoute. */
  failure: SpeechFailure | null;
  /** Vrai : `listen` attend le signal d'arrêt (« Terminer ») avant de rendre le texte. */
  waitForStop: boolean;
  /** Nombre d'écoutes démarrées. */
  listens: number;
}

export function createFakeSpeech(initial: Partial<Pick<FakeSpeech, 'available' | 'transcript' | 'failure' | 'waitForStop'>> = {}): FakeSpeech {
  const fake: FakeSpeech = {
    available: initial.available ?? true,
    transcript: initial.transcript ?? 'Appeler le plombier demain 9 h',
    failure: initial.failure ?? null,
    waitForStop: initial.waitForStop ?? false,
    listens: 0,
    isAvailable: () => Promise.resolve(fake.available),
    listen: (options: ListenOptions) => {
      fake.listens += 1;
      if (fake.failure) return Promise.reject(new SpeechError(fake.failure));
      if (!fake.waitForStop) return Promise.resolve(fake.transcript);
      return new Promise<string>((resolve) => {
        if (options.stopSignal?.aborted) resolve(fake.transcript);
        options.stopSignal?.addEventListener('abort', () => resolve(fake.transcript), { once: true });
      });
    },
  };
  return fake;
}
