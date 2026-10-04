import type { PlainMessageKey } from '../../i18n';

/** Touche pressée pendant la capture d'une combinaison (sous-ensemble de `KeyboardEvent`). */
export interface CaptureKeyEvent {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

export type CapturedChord =
  /** Modificateur seul (Ctrl, Alt, Maj enfoncés avant la touche principale) : on attend la suite. */
  | { readonly kind: 'waiting' }
  | { readonly kind: 'chord'; readonly keys: string }
  | { readonly kind: 'error'; readonly errorKey: PlainMessageKey };

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'OS', 'AltGraph']);
const NAMED_CODES = new Set(['Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Nom de la touche principale en notation du registre, d'après la position physique (`code`) : identique en AZERTY et QWERTY. */
function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1] ?? null;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED_CODES.has(code) ? code : null;
}

/**
 * Convertit la touche pressée en combinaison de la notation du registre (`Ctrl+Alt+Space`), D-04 critère 5.
 * La touche Windows est refusée ici (critère 6) ; les autres refus (réservée, déjà prise) viennent de Rust.
 * Échap n'arrive pas ici : l'appelant l'interprète comme « annuler ».
 */
export function chordFromEvent(event: CaptureKeyEvent): CapturedChord {
  if (MODIFIER_CODES.has(event.code)) return { kind: 'waiting' };
  if (event.metaKey) return { kind: 'error', errorKey: 'shortcutsUi.errors.windowsKey' };
  const key = keyName(event.code);
  if (key === null) return { kind: 'error', errorKey: 'shortcutsUi.errors.syntax' };
  if (!event.ctrlKey && !event.altKey) return { kind: 'error', errorKey: 'shortcutsUi.errors.noModifier' };
  const parts = [event.ctrlKey ? 'Ctrl' : null, event.altKey ? 'Alt' : null, event.shiftKey ? 'Shift' : null, key].filter((part): part is string => part !== null);
  return { kind: 'chord', keys: parts.join('+') };
}
