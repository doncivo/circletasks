import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate, TaskId } from '../../domain/types';
import { INITIAL_NAVIGATION, TABS, useNavigationStore } from './navigation';
import { createShortcutRegistry, type KeyInput, type ShortcutRegistry } from './shortcuts';
import { registerTabShortcuts } from './tabShortcuts';

const alt = (digit: number, over: Partial<KeyInput> = {}): KeyInput => ({
  key: String(digit),
  code: `Digit${String(digit)}`,
  ctrlKey: false,
  altKey: true,
  shiftKey: false,
  metaKey: false,
  editable: false,
  ...over,
});

const task = { type: 'task', id: '0f8fad5b-d9cb-469f-a165-70867728950e' as TaskId } as const;

describe('raccourcis d’onglets Alt+1 à Alt+6 (A-04)', () => {
  let registry: ShortcutRegistry;
  let off: () => void;
  let modal = false;

  beforeEach(() => {
    useNavigationStore.setState(INITIAL_NAVIGATION);
    registry = createShortcutRegistry();
    modal = false;
    off = registerTabShortcuts(registry, () => modal);
  });
  afterEach(() => off());

  const tab = () => useNavigationStore.getState().route.tab;

  it('Alt+1 à Alt+6 activent les six onglets dans l’ordre (critère 6)', () => {
    for (const [index, definition] of TABS.entries()) {
      expect(registry.handle(alt(index + 1))).toBe(definition.shortcut);
      expect(tab()).toBe(definition.id);
    }
  });

  it('Alt+1 revient à Aujourd’hui du jour courant depuis un autre onglet, fiche détail ouverte comprise (critère 1)', () => {
    const nav = useNavigationStore.getState();
    nav.navigate({ tab: 'week', weekStart: null, somedayPanel: false });
    nav.openDetail(task);
    registry.handle(alt(1));
    expect(useNavigationStore.getState()).toMatchObject({ route: { tab: 'tasks', screen: 'today' }, detail: null });
  });

  it('Alt+1 depuis un autre jour ou un sous-écran de Tâches ramène à Aujourd’hui (critère 4, Q10)', () => {
    const nav = useNavigationStore.getState();
    nav.navigate({ tab: 'tasks', screen: 'today', date: '2026-10-03' as LocalDate });
    registry.handle(alt(1));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'tasks', screen: 'today' });
    nav.navigate({ tab: 'tasks', screen: 'done' });
    registry.handle(alt(1));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'tasks', screen: 'today' });
  });

  it('fonctionne dans un champ de saisie et sur clavier AZERTY, où Alt+1 produit « & » (critère 2)', () => {
    expect(registry.handle(alt(2, { key: 'é', editable: true }))).toBe('app.tab.week');
    expect(tab()).toBe('week');
    expect(registry.handle(alt(1, { key: '&', editable: true }))).toBe('app.tab.tasks');
    expect(tab()).toBe('tasks');
  });

  it('ne réagit pas à Ctrl+Alt (AltGr) ni à Alt seul', () => {
    expect(registry.handle(alt(2, { ctrlKey: true }))).toBeNull();
    expect(registry.handle({ ...alt(2), code: 'AltLeft', key: 'Alt' })).toBeNull();
    expect(tab()).toBe('tasks');
  });

  it('ignoré tant qu’une feuille ou une fenêtre modale est ouverte, pour ne pas perdre une saisie (critère 5)', () => {
    modal = true;
    registry.handle(alt(2));
    expect(tab()).toBe('tasks');
    modal = false;
    registry.handle(alt(2));
    expect(tab()).toBe('week');
  });

  it('retire les raccourcis à la fin', () => {
    off();
    expect(registry.handle(alt(2))).toBeNull();
    expect(registry.activeIds()).toEqual([]);
  });
});
