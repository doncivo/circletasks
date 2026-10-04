import type { SpeechRecognizer } from './types';
import { unavailableSpeech } from './unavailable';

export { SpeechError, type ListenOptions, type SpeechFailure, type SpeechRecognizer } from './types';
export { unavailableSpeech } from './unavailable';

let current: SpeechRecognizer = unavailableSpeech;

/** Reconnaisseur courant : « indisponible » à l'ordre 3, le plugin Swift Speech le remplacera à l'ordre 5 (I-05). */
export function getSpeechRecognizer(): SpeechRecognizer {
  return current;
}

/** Branche un reconnaisseur (plugin iOS au démarrage, faux dans les tests). `null` rétablit « indisponible ». */
export function setSpeechRecognizer(recognizer: SpeechRecognizer | null): void {
  current = recognizer ?? unavailableSpeech;
}
