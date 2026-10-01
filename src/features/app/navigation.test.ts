import { beforeEach, describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import type { LocalDate, TaskId } from '../../domain/types';
import { INITIAL_NAVIGATION, TABS, TAB_IDS, useNavigationStore } from './navigation';
import { SHORTCUTS } from './shortcuts';

const task = { type: 'task', id: '0f8fad5b-d9cb-469f-a165-70867728950e' as TaskId } as const;

describe('navigation', () => {
  beforeEach(() => useNavigationStore.setState(INITIAL_NAVIGATION));

  it('démarre sur Aujourd’hui (A-01) et décrit les 6 onglets', () => {
    expect(useNavigationStore.getState().route).toEqual({ tab: 'tasks', screen: 'today' });
    expect(TABS.map((tab) => tab.id)).toEqual([...TAB_IDS]);
    expect(TABS.map((tab) => SHORTCUTS[tab.shortcut].keys)).toEqual(['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5', 'Alt+6']);
    expect(t(TABS[0]?.labelKey ?? 'app.name')).toBe('Tâches');
  });

  it('mémorise le dernier écran de chaque onglet et ferme le détail en changeant d’onglet', () => {
    const nav = useNavigationStore.getState();
    nav.navigate({ tab: 'week', weekStart: '2026-10-12' as LocalDate, somedayPanel: true });
    nav.openDetail(task);
    nav.navigate({ tab: 'week', weekStart: null, somedayPanel: true });
    expect(useNavigationStore.getState().detail).toEqual(task);
    nav.goToTab('tasks');
    expect(useNavigationStore.getState()).toMatchObject({ route: { tab: 'tasks' }, detail: null });
    nav.openDetail(task);
    nav.navigate({ tab: 'routines', screen: 'report' });
    expect(useNavigationStore.getState().detail).toBeNull();
    nav.goToTab('week');
    expect(useNavigationStore.getState().route).toEqual({ tab: 'week', weekStart: null, somedayPanel: true });
  });

  it('Échap ferme la surcouche du dessus, puis le détail, puis rien', () => {
    const nav = useNavigationStore.getState();
    nav.openDetail(task);
    nav.openOverlay({ kind: 'search' });
    nav.openOverlay({ kind: 'shortcutsHelp' });
    expect(nav.escape()).toBe(true);
    expect(useNavigationStore.getState().overlays).toEqual([{ kind: 'search' }]);
    nav.closeOverlay();
    expect(nav.escape()).toBe(true);
    expect(useNavigationStore.getState().detail).toBeNull();
    expect(nav.escape()).toBe(false);
    nav.openDetail(task);
    nav.closeDetail();
    expect(useNavigationStore.getState().detail).toBeNull();
  });
});
