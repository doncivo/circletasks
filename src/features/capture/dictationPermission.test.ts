import { describe, expect, it } from 'vitest';
import type { SpeechPermissionState } from '../../platform/speech';
import { deniedTextKey, dictationGate } from './dictationPermission';

const gate = (microphone: SpeechPermissionState, speechRecognition: SpeechPermissionState) => dictationGate({ microphone, speechRecognition });

/** Table « état d'autorisation → écran » de la dictée (I-05, ADR 0015 §0). */
describe('dictationGate', () => {
  it('tout accordé : l’écoute démarre', () => {
    expect(gate('granted', 'granted')).toEqual({ kind: 'listen' });
  });

  it('une autorisation non décidée : explication avant toute fenêtre d’iOS', () => {
    expect(gate('prompt', 'prompt')).toEqual({ kind: 'explain' });
    expect(gate('granted', 'prompt')).toEqual({ kind: 'explain' });
  });

  it('refus ou restriction : l’écran nomme l’autorisation, le micro d’abord', () => {
    expect(gate('denied', 'granted')).toEqual({ kind: 'denied', permission: 'microphone', restricted: false });
    expect(gate('granted', 'denied')).toEqual({ kind: 'denied', permission: 'speech-recognition', restricted: false });
    expect(gate('restricted', 'granted')).toEqual({ kind: 'denied', permission: 'microphone', restricted: true });
    expect(gate('granted', 'restricted')).toEqual({ kind: 'denied', permission: 'speech-recognition', restricted: true });
    expect(gate('denied', 'denied')).toMatchObject({ permission: 'microphone' });
  });

  it('un refus prime sur une demande à venir (micro non décidé, reconnaissance refusée) : jamais une explication inutile', () => {
    expect(gate('prompt', 'denied')).toEqual({ kind: 'denied', permission: 'speech-recognition', restricted: false });
  });

  it('valeur illisible : dite avec son code, jamais ignorée', () => {
    expect(gate('unknown', 'granted')).toEqual({ kind: 'unknown', permission: 'microphone' });
    expect(gate('granted', 'unknown')).toEqual({ kind: 'unknown', permission: 'speech-recognition' });
    expect(gate('unknown', 'prompt')).toEqual({ kind: 'unknown', permission: 'microphone' });
  });

  it('textes de refus : quatre clés distinctes', () => {
    const keys = [deniedTextKey('microphone', false), deniedTextKey('microphone', true), deniedTextKey('speech-recognition', false), deniedTextKey('speech-recognition', true)];
    expect(new Set(keys).size).toBe(4);
  });
});
