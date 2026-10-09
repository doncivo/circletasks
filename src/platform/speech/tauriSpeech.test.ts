import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSpeechRecognizer, setSpeechRecognizer, SpeechError, unavailableSpeech } from './index';
import { createTauriSpeech, SPEECH_LISTEN_COMMAND, SPEECH_REQUEST_COMMAND, SPEECH_STATUS_COMMAND } from './tauriSpeech';

type Reply = unknown | ((args?: Record<string, unknown>) => unknown);

/** Faux `invoke` : réponses par commande ; un rejet est une valeur `Error` ou `{ code }`. */
function rig(replies: Record<string, Reply>) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const invoke = (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    calls.push({ command, ...(args ? { args } : {}) });
    const reply = replies[command];
    const value = typeof reply === 'function' ? (reply as (a?: Record<string, unknown>) => unknown)(args) : reply;
    return value instanceof Error || typeof value === 'string' || (typeof value === 'object' && value !== null && 'code' in value && !('stopped' in value)) ? Promise.reject(value) : Promise.resolve(value);
  };
  return { calls, logs, speech: createTauriSpeech({ invoke, log: (c) => logs.push(c), stopRetryMs: 5 }) };
}

const status = (over: Record<string, unknown> = {}) => ({ available: true, onDevice: true, microphone: 'granted', speechRecognition: 'granted', ...over });

describe('tauriSpeech : dictée sur l’appareil par les commandes Rust (CAP-IOS-01)', () => {
  afterEach(() => setSpeechRecognizer(null));

  it('isAvailable lit l’état sans rien demander ; plugin muet = faux avec le code au journal (critère 17)', async () => {
    const ok = rig({ [SPEECH_STATUS_COMMAND]: status() });
    expect(await ok.speech.isAvailable()).toBe(true);
    expect(ok.calls.map((c) => c.command)).toEqual([SPEECH_STATUS_COMMAND]);

    const mute = rig({ [SPEECH_STATUS_COMMAND]: status({ available: false, reason: 'plugin-unavailable' }) });
    expect(await mute.speech.isAvailable()).toBe(false);
    expect(mute.logs).toEqual(['speech-plugin-unavailable']);

    const refused = rig({ [SPEECH_STATUS_COMMAND]: new Error('not allowed') });
    expect(await refused.speech.isAvailable()).toBe(false);
    expect(refused.logs).toEqual(['speech-plugin-unavailable']);
  });

  it('permissions : les cinq états ; une valeur inattendue devient « unknown »', async () => {
    const r = rig({ [SPEECH_STATUS_COMMAND]: status({ microphone: 'prompt', speechRecognition: 'limited' }) });
    expect(await r.speech.permissions?.()).toEqual({ microphone: 'prompt', speechRecognition: 'unknown' });
    expect(await r.speech.onDeviceReady?.()).toBe(true);
    const off = rig({ [SPEECH_STATUS_COMMAND]: status({ onDevice: false }) });
    expect(await off.speech.onDeviceReady?.()).toBe(false);
    // Lecture en échec ou réponse sans le champ : état inconnu (undefined), jamais « modèle absent » (false).
    const broken = rig({ [SPEECH_STATUS_COMMAND]: new Error('x') });
    expect(await broken.speech.onDeviceReady?.()).toBeUndefined();
    const silent = rig({ [SPEECH_STATUS_COMMAND]: status({ onDevice: undefined }) });
    expect(await silent.speech.onDeviceReady?.()).toBeUndefined();
  });

  it('permissions : plugin absent ou lecture en échec = SpeechError avec code', async () => {
    const absent = rig({ [SPEECH_STATUS_COMMAND]: status({ available: false, reason: 'plugin-unavailable' }) });
    await expect(absent.speech.permissions?.()).rejects.toMatchObject({ reason: 'unavailable', code: 'speech-plugin-unavailable' });
    const broken = rig({ [SPEECH_STATUS_COMMAND]: new Error('x') });
    await expect(broken.speech.permissions?.()).rejects.toMatchObject({ reason: 'failed', code: 'speech-status-failed' });
  });

  it('requestPermissions : la seule commande de demande ; états lus après coup', async () => {
    const r = rig({ [SPEECH_REQUEST_COMMAND]: { microphone: 'granted', speechRecognition: 'denied' } });
    expect(await r.speech.requestPermissions?.()).toEqual({ microphone: 'granted', speechRecognition: 'denied' });
    expect(r.calls.map((c) => c.command)).toEqual([SPEECH_REQUEST_COMMAND]);
    const failing = rig({ [SPEECH_REQUEST_COMMAND]: { code: 'speech-unavailable', message: 'unavailable' } });
    await expect(failing.speech.requestPermissions?.()).rejects.toMatchObject({ reason: 'unavailable', code: 'speech-unavailable' });
  });

  it('listen : texte rendu, cause transmise à onStopped, langue française seulement', async () => {
    const r = rig({ [SPEECH_LISTEN_COMMAND]: { text: 'Appeler le plombier demain 9 h', stoppedBy: 'time-limit' } });
    const stops: string[] = [];
    const text = await r.speech.listen({ locale: 'fr-FR', onStopped: (reason) => stops.push(reason) });
    expect(text).toBe('Appeler le plombier demain 9 h');
    expect(stops).toEqual(['time-limit']);
    expect(r.calls[0]).toEqual({ command: SPEECH_LISTEN_COMMAND, args: { locale: 'fr-FR' } });
  });

  it('listen : codes de Rust → raisons de SpeechError', async () => {
    const cases: Array<[string, string, string | undefined]> = [
      ['speech-microphone-denied', 'permission-denied', 'microphone'],
      ['speech-recognition-denied', 'permission-denied', 'speech-recognition'],
      ['speech-on-device-unavailable', 'on-device-unavailable', undefined],
      ['speech-busy', 'busy', undefined],
      ['speech-unavailable', 'unavailable', undefined],
      ['speech-timeout', 'failed', undefined],
      ['speech-audio-unavailable', 'failed', undefined],
    ];
    for (const [code, reason, permission] of cases) {
      const r = rig({ [SPEECH_LISTEN_COMMAND]: { code, message: 'texte reconnu confidentiel' } });
      const error = (await r.speech.listen({ locale: 'fr-FR' }).catch((e: unknown) => e)) as SpeechError;
      expect(error).toBeInstanceOf(SpeechError);
      expect(error.reason).toBe(reason);
      expect(error.code).toBe(code);
      expect(error.permission).toBe(permission);
      expect(error.message).not.toContain('confidentiel');
    }
    const odd = rig({ [SPEECH_LISTEN_COMMAND]: 'command speech_listen not allowed by ACL' });
    expect(await odd.speech.listen({ locale: 'fr-FR' }).catch((e: unknown) => e)).toMatchObject({ reason: 'failed', code: 'speech-invoke-failed' });
  });

  it('« Terminer » : speech_stop part, et se répète tant que Rust n’a pas pris l’écoute (course), puis le texte arrive', async () => {
    let stops = 0;
    let release: (value: unknown) => void = () => undefined;
    const speech = createTauriSpeech({
      stopRetryMs: 5,
      invoke: (command) => {
        if (command === SPEECH_LISTEN_COMMAND) {
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        stops += 1;
        if (stops === 3) release({ text: 'bonjour', stoppedBy: 'user' });
        return Promise.resolve({ stopped: stops >= 3 });
      },
    });
    const controller = new AbortController();
    const pending = speech.listen({ locale: 'fr-FR', stopSignal: controller.signal });
    controller.abort();
    expect(await pending).toBe('bonjour');
    expect(stops).toBe(3);
  });

  it('signal déjà déclenché : aucune écoute n’est démarrée', async () => {
    const r = rig({ [SPEECH_LISTEN_COMMAND]: { text: 'x', stoppedBy: 'user' } });
    const controller = new AbortController();
    controller.abort();
    expect(await r.speech.listen({ locale: 'fr-FR', stopSignal: controller.signal })).toBe('');
    expect(r.calls).toEqual([]);
  });

  it('availability : plugin muet = indisponible AVEC un code à dire (impasse corrigée)', async () => {
    const mute = rig({ [SPEECH_STATUS_COMMAND]: status({ available: false, reason: 'plugin-unavailable' }) });
    expect(await mute.speech.availability?.()).toEqual({ available: false, code: 'speech-plugin-unavailable' });
    const noRecognizer = rig({ [SPEECH_STATUS_COMMAND]: status({ available: false, reason: 'recognizer-unavailable' }) });
    expect(await noRecognizer.speech.availability?.()).toEqual({ available: false, code: 'speech-recognizer-unavailable' });
    const refused = rig({ [SPEECH_STATUS_COMMAND]: new Error('not allowed') });
    expect(await refused.speech.availability?.()).toEqual({ available: false, code: 'speech-plugin-unavailable' });
    const ok = rig({ [SPEECH_STATUS_COMMAND]: status() });
    expect(await ok.speech.availability?.()).toEqual({ available: true });
  });
});

describe('openSpeechRecognizer : branchement au démarrage (CAP-IOS-01 critère 7, I-05 critère 6)', () => {
  it('PC, navigateur : « indisponible » (Win + H)', () => {
    const log = vi.fn();
    expect(openSpeechRecognizer('tauri', 'windows', { log })).toBe(unavailableSpeech);
    expect(openSpeechRecognizer('web', 'ios', { log })).toBe(unavailableSpeech);
  });

  it('(tauri, ios) : un reconnaisseur paresseux qui ne fait AUCUN appel à la création', () => {
    const log = vi.fn();
    const speech = openSpeechRecognizer('tauri', 'ios', { log });
    expect(speech).not.toBe(unavailableSpeech);
    expect(typeof speech.requestPermissions).toBe('function');
    expect(typeof speech.availability).toBe('function');
    expect(log).not.toHaveBeenCalled();
  });
});
