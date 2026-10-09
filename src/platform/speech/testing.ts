import {
  SpeechError,
  type ListenOptions,
  type SpeechFailure,
  type SpeechPermissions,
  type SpeechPermissionState,
  type SpeechRecognizer,
  type SpeechStopReason,
} from './types';

/** Un appel reçu par le faux, dans l'ordre (I-05 critères 7 et 11 : journal des demandes d'autorisation et des ouvertures de Réglages). */
export type FakeSpeechCall = 'isAvailable' | 'permissions' | 'requestPermissions' | 'onDeviceReady' | 'listen' | 'availability';

/** Faux `SpeechRecognizer` des tests : texte prédéfini, refus de permission possible, attente de « Terminer » possible, autorisations simulées. */
export interface FakeSpeech extends SpeechRecognizer {
  available: boolean;
  /** Texte rendu par `listen`. */
  transcript: string;
  /** Cause d'un échec à la prochaine écoute. */
  failure: SpeechFailure | null;
  /** Autorisation citée par un `permission-denied` (absente : refus générique, cas de Q-03). */
  deniedPermission: 'microphone' | 'speech-recognition' | undefined;
  /** Code de la commande Rust joint aux échecs (affiché par l'écran). */
  failureCode: string | undefined;
  /** Vrai : `listen` attend le signal d'arrêt (« Terminer ») avant de rendre le texte. */
  waitForStop: boolean;
  /** Cause rendue à `onStopped` quand l'écoute se termine. */
  stoppedBy: SpeechStopReason;
  /** Nombre d'écoutes démarrées. */
  listens: number;
  /** État des autorisations lu par `permissions()`. */
  state: { microphone: SpeechPermissionState; speechRecognition: SpeechPermissionState };
  /** État après `requestPermissions()` (absent : tout accordé). */
  afterRequest: SpeechPermissions | null;
  /** Modèle hors ligne présent. */
  onDevice: boolean;
  /** Lecture de la présence du modèle en échec : `onDeviceReady()` rend `undefined` (état inconnu). */
  onDeviceFail: boolean;
  /** Code rendu par `availability()` quand le service est indisponible. */
  unavailableCode: string | undefined;
  /** Lecture de l'état en échec (erreur de la commande). */
  permissionsFail: boolean;
  /** Appels reçus, dans l'ordre. */
  calls: FakeSpeechCall[];
}

type FakeSpeechInit = Partial<
  Pick<
    FakeSpeech,
    'available' | 'transcript' | 'failure' | 'waitForStop' | 'deniedPermission' | 'failureCode' | 'stoppedBy' | 'onDevice' | 'onDeviceFail' | 'afterRequest' | 'unavailableCode' | 'permissionsFail'
  >
> & { state?: Partial<FakeSpeech['state']> };

export function createFakeSpeech(initial: FakeSpeechInit = {}): FakeSpeech {
  const record = (call: FakeSpeechCall): void => {
    fake.calls.push(call);
  };
  const fake: FakeSpeech = {
    available: initial.available ?? true,
    transcript: initial.transcript ?? 'Appeler le plombier demain 9 h',
    failure: initial.failure ?? null,
    deniedPermission: initial.deniedPermission,
    failureCode: initial.failureCode,
    waitForStop: initial.waitForStop ?? false,
    stoppedBy: initial.stoppedBy ?? 'user',
    listens: 0,
    state: { microphone: 'granted', speechRecognition: 'granted', ...initial.state },
    afterRequest: initial.afterRequest ?? null,
    onDevice: initial.onDevice ?? true,
    unavailableCode: initial.unavailableCode,
    permissionsFail: initial.permissionsFail ?? false,
    onDeviceFail: initial.onDeviceFail ?? false,
    calls: [],
    isAvailable: () => {
      record('isAvailable');
      return Promise.resolve(fake.available);
    },
    permissions: () => {
      record('permissions');
      if (fake.permissionsFail) return Promise.reject(new SpeechError('failed', undefined, { code: 'speech-status-failed' }));
      return Promise.resolve({ ...fake.state });
    },
    requestPermissions: () => {
      record('requestPermissions');
      fake.state = { ...(fake.afterRequest ?? { microphone: 'granted', speechRecognition: 'granted' }) };
      return Promise.resolve({ ...fake.state });
    },
    onDeviceReady: () => {
      record('onDeviceReady');
      return Promise.resolve(fake.onDeviceFail ? undefined : fake.onDevice);
    },
    availability: () => {
      record('availability');
      return Promise.resolve(fake.available ? { available: true } : { available: false, ...(fake.unavailableCode ? { code: fake.unavailableCode } : {}) });
    },
    listen: (options: ListenOptions) => {
      fake.listens += 1;
      record('listen');
      if (fake.failure) {
        return Promise.reject(
          new SpeechError(fake.failure, undefined, {
            ...(fake.deniedPermission !== undefined ? { permission: fake.deniedPermission } : {}),
            ...(fake.failureCode !== undefined ? { code: fake.failureCode } : {}),
          }),
        );
      }
      if (!fake.waitForStop) {
        options.onStopped?.(fake.stoppedBy);
        return Promise.resolve(fake.transcript);
      }
      return new Promise<string>((resolve) => {
        const done = (): void => {
          options.onStopped?.(fake.stoppedBy);
          resolve(fake.transcript);
        };
        if (options.stopSignal?.aborted) done();
        options.stopSignal?.addEventListener('abort', done, { once: true });
      });
    },
  };
  return fake;
}
