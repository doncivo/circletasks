import { describe, expect, it, vi } from 'vitest';
import { SHORTCUTS, createShortcutRegistry, parseChord, type KeyInput, type ShortcutId } from './shortcuts';
import { RESERVED_SHORTCUTS } from './shortcutsHelp';

/** D-04 critères 1, 3 et 4 : chaque raccourci du registre, pris un par un (QA). */
const ids = (Object.keys(SHORTCUTS) as ShortcutId[]).filter((id) => SHORTCUTS[id].scope !== 'global');

/** Frappe correspondant à la notation du registre, sur clavier QWERTY ou AZERTY. */
function inputFor(id: ShortcutId, layout: 'qwerty' | 'azerty', editable = false): KeyInput {
  const c = parseChord(SHORTCUTS[id].keys);
  const digit = /^[0-9]$/.test(c.key);
  const key = c.key === 'Space' ? ' ' : /^[A-Z]$/.test(c.key) ? (c.shift ? c.key : c.key.toLowerCase()) : digit && layout === 'azerty' ? '&é"\'(-'[Number(c.key) - 1] ?? c.key : c.key;
  const code = digit ? `Digit${c.key}` : c.key.length === 1 ? `Key${c.key}` : c.key;
  return { key, code, ctrlKey: c.ctrl, altKey: c.alt, shiftKey: c.shift, metaKey: false, editable };
}

describe('registre complet (D-04 critères 1 et 4)', () => {
  it.each(ids)('%s : sa combinaison déclenche son gestionnaire et lui seul, en QWERTY comme en AZERTY', (id) => {
    for (const layout of ['qwerty', 'azerty'] as const) {
      const registry = createShortcutRegistry();
      const spies = new Map(ids.map((other) => [other, vi.fn()]));
      for (const [other, spy] of spies) registry.register(other, spy);
      expect(registry.handle(inputFor(id, layout))).toBe(id);
      for (const [other, spy] of spies) expect(spy).toHaveBeenCalledTimes(other === id ? 1 : 0);
    }
  });

  it.each(ids)('%s : dans un champ de saisie, agit seulement si déclaré inEditable', (id) => {
    const registry = createShortcutRegistry();
    const spy = vi.fn();
    registry.register(id, spy);
    registry.handle(inputFor(id, 'qwerty', true));
    expect(spy).toHaveBeenCalledTimes(SHORTCUTS[id].inEditable ? 1 : 0);
  });

  it('Espace, Suppr, Ctrl+D, Ctrl+Maj+D, ↑ / ↓ et Ctrl+Z ne sont jamais pris dans un champ', () => {
    for (const id of ['list.complete', 'list.delete', 'list.postponeTomorrow', 'list.duplicate', 'list.previous', 'list.next', 'app.undo'] as const) {
      expect(SHORTCUTS[id].inEditable, id).toBe(false);
    }
  });

  it('Ctrl+/, Ctrl+, , Échap et Alt+1..6 restent actifs dans un champ', () => {
    for (const id of ['app.shortcutsHelp', 'app.settings', 'app.escape', 'app.tab.tasks', 'app.tab.settings', 'app.space.pro'] as const) {
      expect(SHORTCUTS[id].inEditable, id).toBe(true);
    }
  });

  it('aucun raccourci n’est plus réservé : Focus (F-01) a son gestionnaire', () => {
    expect(RESERVED_SHORTCUTS).toEqual([]);
  });
});
