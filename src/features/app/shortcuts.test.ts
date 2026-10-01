import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n';
import { SHORTCUTS, createShortcutRegistry, matchesChord, parseChord, toKeyInput, type KeyInput } from './shortcuts';

const key = (partial: Partial<KeyInput> & Pick<KeyInput, 'key'>): KeyInput => ({
  code: '',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  editable: false,
  ...partial,
});

describe('combinaisons', () => {
  it('lit la notation', () => {
    expect(parseChord('Ctrl+Shift+D')).toEqual({ key: 'D', ctrl: true, alt: false, shift: true });
    expect(() => parseChord('Cmd+K')).toThrow(SyntaxError);
    expect(() => parseChord('Ctrl+')).toThrow(SyntaxError);
  });

  it('reconnaît Alt+1 sur un clavier AZERTY (touche « & »)', () => {
    expect(matchesChord(parseChord('Alt+1'), key({ key: '&', code: 'Digit1', altKey: true }))).toBe(true);
    expect(matchesChord(parseChord('Alt+1'), key({ key: '1', code: 'Numpad1', altKey: true }))).toBe(true);
    // AltGr (Ctrl+Alt) ne déclenche pas Alt+1.
    expect(matchesChord(parseChord('Alt+1'), key({ key: '~', code: 'Digit2', altKey: true, ctrlKey: true }))).toBe(false);
  });

  it('compare lettres, symboles et touches nommées', () => {
    expect(matchesChord(parseChord('Ctrl+Z'), key({ key: 'z', ctrlKey: true }))).toBe(true);
    expect(matchesChord(parseChord('Ctrl+Shift+D'), key({ key: 'D', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesChord(parseChord('Ctrl+D'), key({ key: 'D', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(matchesChord(parseChord('Ctrl+/'), key({ key: '/', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesChord(parseChord('Space'), key({ key: ' ' }))).toBe(true);
    expect(matchesChord(parseChord('Ctrl+ArrowLeft'), key({ key: 'ArrowLeft', ctrlKey: true }))).toBe(true);
    expect(matchesChord(parseChord('Ctrl+K'), key({ key: 'k', metaKey: true, ctrlKey: true }))).toBe(false);
  });

  it('chaque raccourci a une description traduite', () => {
    for (const def of Object.values(SHORTCUTS)) expect(t(def.descriptionKey)).not.toBe(def.descriptionKey);
  });
});

describe('registre', () => {
  it('appelle le dernier gestionnaire enregistré, puis le précédent', () => {
    const registry = createShortcutRegistry();
    const today = vi.fn();
    const week = vi.fn();
    registry.register('list.complete', today);
    const off = registry.register('list.complete', week);
    expect(registry.handle(key({ key: ' ' }))).toBe('list.complete');
    expect(week).toHaveBeenCalledOnce();
    off();
    registry.handle(key({ key: ' ' }));
    expect(today).toHaveBeenCalledOnce();
    expect(registry.activeIds()).toEqual(['list.complete']);
  });

  it('ignore les raccourcis de liste dans un champ de saisie, garde ceux de l’app', () => {
    const registry = createShortcutRegistry();
    const undo = vi.fn();
    const tab = vi.fn();
    registry.register('app.undo', undo);
    registry.register('app.tab.tasks', tab);
    expect(registry.handle(key({ key: 'z', ctrlKey: true, editable: true }))).toBeNull();
    expect(registry.handle(key({ key: '&', code: 'Digit1', altKey: true, editable: true }))).toBe('app.tab.tasks');
    expect(undo).not.toHaveBeenCalled();
    expect(tab).toHaveBeenCalledOnce();
  });

  it('ne gère ni le raccourci global ni une touche sans gestionnaire', () => {
    const registry = createShortcutRegistry();
    registry.register('global.quickCapture', vi.fn());
    expect(registry.handle(key({ key: ' ', ctrlKey: true, altKey: true }))).toBeNull();
    expect(registry.handle(key({ key: 'k', ctrlKey: true }))).toBeNull();
    const off = registry.register('app.search', vi.fn());
    off();
    expect(registry.activeIds()).toEqual(['global.quickCapture']);
  });

  it('convertit un événement hors DOM (Node) sans champ éditable', () => {
    const input = toKeyInput({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, target: null } as unknown as KeyboardEvent);
    expect(input).toMatchObject({ key: 'k', code: 'KeyK', ctrlKey: true, editable: false });
  });
});
