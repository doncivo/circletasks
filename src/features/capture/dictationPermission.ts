import type { SpeechPermissions } from '../../platform/speech';

/**
 * Table « état d'autorisation → écran » de la dictée sur iPhone (I-05, ADR 0015 §0 : présentation de plateforme, pas une règle métier).
 * Fonction pure : le micro et la reconnaissance vocale sont deux autorisations distinctes, demandées dans cet ordre par iOS.
 *
 * - un refus (`denied`) ou une restriction (`restricted`) bloque l'écoute et se dit, en nommant l'autorisation concernée (le micro d'abord) ;
 * - une valeur illisible (`unknown`) est dite avec son code (aucun échec silencieux) ;
 * - une autorisation non décidée (`prompt`) demande d'abord l'explication, puis les fenêtres d'iOS ;
 * - sinon, l'écoute peut démarrer.
 */
export type DictationPermission = 'microphone' | 'speech-recognition';

export type DictationGate =
  | { readonly kind: 'listen' }
  | { readonly kind: 'explain' }
  | { readonly kind: 'denied'; readonly permission: DictationPermission; readonly restricted: boolean }
  | { readonly kind: 'unknown'; readonly permission: DictationPermission };

export function dictationGate(state: SpeechPermissions): DictationGate {
  const entries: ReadonlyArray<readonly [DictationPermission, SpeechPermissions['microphone']]> = [
    ['microphone', state.microphone],
    ['speech-recognition', state.speechRecognition],
  ];
  for (const [permission, value] of entries) {
    if (value === 'denied' || value === 'restricted') return { kind: 'denied', permission, restricted: value === 'restricted' };
  }
  for (const [permission, value] of entries) {
    if (value === 'unknown') return { kind: 'unknown', permission };
  }
  if (entries.some(([, value]) => value === 'prompt')) return { kind: 'explain' };
  return { kind: 'listen' };
}

/** Clé de texte du refus ou de la restriction d'une autorisation (`capture.dictation.denied.*`). */
export function deniedTextKey(permission: DictationPermission, restricted: boolean) {
  if (permission === 'microphone') return restricted ? ('capture.dictation.denied.microphoneRestricted' as const) : ('capture.dictation.denied.microphone' as const);
  return restricted ? ('capture.dictation.denied.speechRecognitionRestricted' as const) : ('capture.dictation.denied.speechRecognition' as const);
}
