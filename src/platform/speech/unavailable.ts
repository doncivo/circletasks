import { SpeechError, type SpeechRecognizer } from './types';

/** Implémentation de l'ordre 3 : aucun moteur dans l'app, `isAvailable()` est toujours faux. */
export const unavailableSpeech: SpeechRecognizer = {
  isAvailable: () => Promise.resolve(false),
  listen: () => Promise.reject(new SpeechError('unavailable')),
};
