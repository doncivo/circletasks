import { SpeechError, type ListenOptions, type SpeechPermissions, type SpeechPermissionState, type SpeechRecognizer, type SpeechStopReason } from './types';

/**
 * Dictée sur l'iPhone par les commandes Rust `speech_*` et `app_settings_open` (CAP-IOS-01, ADR 0015 §2.3) : **seul** fichier qui les nomme.
 * Le plugin Swift reconnaît le français SUR L'APPAREIL (aucun audio n'est envoyé) et n'est appelé que par Rust. Rien n'est gardé ici : ni
 * texte reconnu, ni état d'autorisation. Aucune demande d'autorisation n'est faite ailleurs que dans `requestPermissions`, appelée par
 * « Continuer » (I-05) ; `isAvailable` et `permissions` LISENT seulement (aucune fenêtre d'iOS).
 */

/** Commandes Rust (src-tauri/src/speech/ios.rs). */
export const SPEECH_STATUS_COMMAND = 'speech_status';
export const SPEECH_REQUEST_COMMAND = 'speech_request_permissions';
export const SPEECH_LISTEN_COMMAND = 'speech_listen';
export const SPEECH_STOP_COMMAND = 'speech_stop';
export const SETTINGS_OPEN_COMMAND = 'app_settings_open';

export type SpeechInvoker = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface TauriSpeechOptions {
  readonly invoke?: SpeechInvoker;
  /** Journal technique (code seul : jamais un texte reconnu ni un état d'autorisation). */
  readonly log?: (code: string) => void;
  /** Intervalle entre deux essais de `speech_stop` quand l'écoute n'a pas encore démarré côté Rust (course au toucher de « Terminer »). */
  readonly stopRetryMs?: number;
}

/** `invoke` de Tauri, chargé à la demande. */
function tauriInvoker(): SpeechInvoker {
  return async (command, args) => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke(command, args ?? {});
  };
}

const STOP_MAX_TRIES = 40;
const STOP_RETRY_MS = 100;

function toState(value: unknown): SpeechPermissionState {
  return value === 'granted' || value === 'denied' || value === 'restricted' || value === 'prompt' ? value : 'unknown';
}

function toStopReason(value: unknown): SpeechStopReason {
  return value === 'user' || value === 'time-limit' || value === 'background' ? value : 'interrupted';
}

/** Code `{ code, message }` d'une commande Rust ; jamais le message (il ne porte qu'un code, mais rien n'est recopié). */
function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && /^[a-z-]{1,40}$/.test(code)) return code;
  }
  return '';
}

/** Échec de `speech_listen` → `SpeechError` (ADR 0015 §2.3). */
export function toSpeechError(error: unknown): SpeechError {
  const code = codeOf(error);
  switch (code) {
    case 'speech-microphone-denied':
      return new SpeechError('permission-denied', error, { permission: 'microphone', code });
    case 'speech-recognition-denied':
      return new SpeechError('permission-denied', error, { permission: 'speech-recognition', code });
    case 'speech-on-device-unavailable':
      return new SpeechError('on-device-unavailable', error, { code });
    case 'speech-busy':
      return new SpeechError('busy', error, { code });
    case 'speech-unavailable':
      return new SpeechError('unavailable', error, { code });
    default:
      return new SpeechError('failed', error, { code: code === '' ? 'speech-invoke-failed' : code });
  }
}

interface StatusJson {
  readonly available?: unknown;
  readonly onDevice?: unknown;
  readonly microphone?: unknown;
  readonly speechRecognition?: unknown;
  readonly reason?: unknown;
}

export function createTauriSpeech(options: TauriSpeechOptions = {}): SpeechRecognizer {
  const invoke = options.invoke ?? tauriInvoker();
  const log = options.log ?? (() => undefined);
  const retryMs = options.stopRetryMs ?? STOP_RETRY_MS;
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  async function status(): Promise<StatusJson> {
    return (await invoke(SPEECH_STATUS_COMMAND)) as StatusJson;
  }

  return {
    isAvailable: async () => {
      try {
        const current = await status();
        if (current.available === true) return true;
        log(current.reason === 'plugin-unavailable' ? 'speech-plugin-unavailable' : 'speech-recognizer-unavailable');
        return false;
      } catch {
        log('speech-plugin-unavailable');
        return false;
      }
    },

    permissions: async () => {
      let current: StatusJson;
      try {
        current = await status();
      } catch (error) {
        throw new SpeechError('failed', error, { code: 'speech-status-failed' });
      }
      if (current.reason === 'plugin-unavailable') throw new SpeechError('unavailable', undefined, { code: 'speech-plugin-unavailable' });
      return { microphone: toState(current.microphone), speechRecognition: toState(current.speechRecognition) };
    },

    onDeviceReady: async () => {
      try {
        return (await status()).onDevice === true;
      } catch {
        return false;
      }
    },

    requestPermissions: async (): Promise<SpeechPermissions> => {
      try {
        const result = (await invoke(SPEECH_REQUEST_COMMAND)) as StatusJson;
        return { microphone: toState(result.microphone), speechRecognition: toState(result.speechRecognition) };
      } catch (error) {
        throw new SpeechError('unavailable', error, { code: codeOf(error) || 'speech-unavailable' });
      }
    },

    openSettings: async () => {
      try {
        const result = (await invoke(SETTINGS_OPEN_COMMAND)) as { opened?: unknown };
        if (result.opened !== true) throw new SpeechError('failed', undefined, { code: 'settings-open-failed' });
      } catch (error) {
        if (error instanceof SpeechError) throw error;
        throw new SpeechError('failed', error, { code: 'settings-open-failed' });
      }
    },

    listen: async (listenOptions: ListenOptions): Promise<string> => {
      const signal = listenOptions.stopSignal;
      // Arrêt demandé avant même le départ : rien n'est écouté.
      if (signal?.aborted) return '';
      let pending = true;
      // `speech_stop` peut arriver avant que Rust ait pris l'écoute (toucher immédiat de « Terminer ») : il rend alors `stopped: false` ; on
      // réessaie tant que l'écoute est en attente, pour qu'aucune écoute ne continue après la demande d'arrêt.
      const requestStop = async (): Promise<void> => {
        for (let attempt = 0; pending && attempt < STOP_MAX_TRIES; attempt += 1) {
          try {
            const result = (await invoke(SPEECH_STOP_COMMAND)) as { stopped?: unknown };
            if (result.stopped === true) return;
          } catch {
            log('speech-stop-failed');
          }
          await sleep(retryMs);
        }
      };
      const onAbort = (): void => {
        void requestStop();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result = (await invoke(SPEECH_LISTEN_COMMAND, { locale: listenOptions.locale })) as { text?: unknown; stoppedBy?: unknown };
        listenOptions.onStopped?.(toStopReason(result.stoppedBy));
        return typeof result.text === 'string' ? result.text : '';
      } catch (error) {
        throw toSpeechError(error);
      } finally {
        pending = false;
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
