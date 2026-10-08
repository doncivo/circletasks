import type { OsFamily, Runtime } from '../runtime';
import type { SpeechRecognizer } from './types';
import { unavailableSpeech } from './unavailable';
export {
  SpeechError,
  type ListenOptions,
  type SpeechErrorDetails,
  type SpeechFailure,
  type SpeechPermissionState,
  type SpeechPermissions,
  type SpeechRecognizer,
  type SpeechStopReason,
} from './types';
export { unavailableSpeech } from './unavailable';

let current: SpeechRecognizer = unavailableSpeech;

/** Reconnaisseur courant : « indisponible » tant que rien n'est branché (PC, navigateur) ; le plugin Swift Speech le remplace sur iPhone (I-05). */
export function getSpeechRecognizer(): SpeechRecognizer {
  return current;
}

/** Branche un reconnaisseur (plugin iOS au démarrage, faux dans les tests). `null` rétablit « indisponible ». */
export function setSpeechRecognizer(recognizer: SpeechRecognizer | null): void {
  current = recognizer ?? unavailableSpeech;
}

/**
 * Lecture paresseuse (le bloc de l'adaptateur n'est chargé qu'au premier usage, hors du bundle de départ). Les méthodes optionnelles sont
 * toujours présentes : l'adaptateur Tauri les implémente toutes.
 */
function lazySpeech(load: () => Promise<SpeechRecognizer>, log: (code: string) => void): SpeechRecognizer {
  let loaded: Promise<SpeechRecognizer> | null = null;
  const get = (): Promise<SpeechRecognizer> => (loaded ??= load());
  const required = async <T>(pick: (recognizer: SpeechRecognizer) => (() => Promise<T>) | undefined): Promise<T> => {
    const method = pick(await get());
    if (!method) throw new Error('speech-method-missing');
    return method();
  };
  return {
    isAvailable: async () => {
      try {
        return await (await get()).isAvailable();
      } catch {
        // Bloc de l'adaptateur introuvable : le micro n'est pas affiché, et l'échec reste au journal (aucun échec silencieux).
        loaded = null;
        log('speech-plugin-unavailable');
        return false;
      }
    },
    listen: async (options) => (await get()).listen(options),
    permissions: () => required((r) => r.permissions?.bind(r)),
    requestPermissions: () => required((r) => r.requestPermissions?.bind(r)),
    onDeviceReady: () => required((r) => r.onDeviceReady?.bind(r)),
    openSettings: () => required((r) => r.openSettings?.bind(r)),
  };
}

/**
 * Résolveur (ADR 0015 §2.3) : le plugin Speech pour (`tauri`, `ios`) seulement, **sans** lecture d'état ni demande d'autorisation au
 * démarrage ; « indisponible » partout ailleurs (PC : Win + H). En développement seulement, `globalThis.__ctSpeech` (faux injecté par
 * l'e2e) remplace tout ; retiré du build de production.
 */
export function openSpeechRecognizer(runtime: Runtime, os: OsFamily, deps: { readonly log: (code: string) => void }): SpeechRecognizer {
  if (import.meta.env.DEV) {
    const injected = (globalThis as { __ctSpeech?: SpeechRecognizer }).__ctSpeech;
    if (injected) return injected;
  }
  if (runtime === 'tauri' && os === 'ios') {
    return lazySpeech(async () => (await import('./tauriSpeech')).createTauriSpeech({ log: deps.log }), deps.log);
  }
  return unavailableSpeech;
}
