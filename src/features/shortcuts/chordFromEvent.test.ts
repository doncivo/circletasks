import { describe, expect, it } from 'vitest';
import { chordFromEvent, type CaptureKeyEvent } from './chordFromEvent';

const ev = (code: string, mods: Partial<Omit<CaptureKeyEvent, 'code'>> = {}): CaptureKeyEvent => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('chordFromEvent (D-04 critère 5)', () => {
  it('compose la notation du registre dans l’ordre Ctrl, Alt, Maj', () => {
    expect(chordFromEvent(ev('Space', { ctrlKey: true, shiftKey: true }))).toEqual({ kind: 'chord', keys: 'Ctrl+Shift+Space' });
    expect(chordFromEvent(ev('KeyQ', { shiftKey: true, altKey: true, ctrlKey: true }))).toEqual({ kind: 'chord', keys: 'Ctrl+Alt+Shift+Q' });
    expect(chordFromEvent(ev('F9', { altKey: true }))).toEqual({ kind: 'chord', keys: 'Alt+F9' });
  });

  it('lit la touche par sa position physique : identique en AZERTY et en QWERTY', () => {
    // Ctrl+& en AZERTY et Ctrl+1 en QWERTY sont la même touche physique.
    expect(chordFromEvent(ev('Digit1', { ctrlKey: true }))).toEqual({ kind: 'chord', keys: 'Ctrl+1' });
    expect(chordFromEvent(ev('Numpad4', { altKey: true }))).toEqual({ kind: 'chord', keys: 'Alt+4' });
  });

  it('attend la touche principale quand seul un modificateur est enfoncé', () => {
    for (const code of ['ControlLeft', 'AltRight', 'ShiftLeft', 'AltGraph']) {
      expect(chordFromEvent(ev(code, { ctrlKey: true }))).toEqual({ kind: 'waiting' });
    }
  });

  it('refuse la touche Windows, l’absence de Ctrl ou Alt et les touches inconnues', () => {
    expect(chordFromEvent(ev('Space', { ctrlKey: true, metaKey: true }))).toEqual({ kind: 'error', errorKey: 'shortcutsUi.errors.windowsKey' });
    expect(chordFromEvent(ev('KeyK'))).toEqual({ kind: 'error', errorKey: 'shortcutsUi.errors.noModifier' });
    expect(chordFromEvent(ev('KeyK', { shiftKey: true }))).toEqual({ kind: 'error', errorKey: 'shortcutsUi.errors.noModifier' });
    expect(chordFromEvent(ev('Comma', { ctrlKey: true }))).toEqual({ kind: 'error', errorKey: 'shortcutsUi.errors.syntax' });
    expect(chordFromEvent(ev('F25', { ctrlKey: true }))).toEqual({ kind: 'error', errorKey: 'shortcutsUi.errors.syntax' });
  });
});
