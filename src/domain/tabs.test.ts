import { describe, expect, it } from 'vitest';
import { DEFAULT_TABS_CONFIG, hiddenTabs, isTabAvailable, moveTab, orderedCustomizableTabs, resolveTabs, setTabHidden, visibleTabCount } from './tabs';

const ALL = ['tasks', 'week', 'routines', 'events', 'checklists', 'settings'];

describe('resolveTabs (P-01)', () => {
  it('ordre d’origine par défaut : Tâches en tête, Réglages en bas', () => {
    expect(resolveTabs(DEFAULT_TABS_CONFIG, ALL, 'tasks')).toEqual({ rail: ['tasks', 'week', 'routines', 'events', 'checklists'], last: 'settings' });
  });

  it('applique l’ordre choisi : Checklists au-dessus de Routines (critère 2)', () => {
    const config = moveTab(DEFAULT_TABS_CONFIG, ALL, 'checklists', 1);
    expect(resolveTabs(config, ALL, 'tasks').rail).toEqual(['tasks', 'week', 'checklists', 'routines', 'events']);
  });

  it('masque un onglet sans perdre les autres (critère 4)', () => {
    const config = setTabHidden(DEFAULT_TABS_CONFIG, ALL, 'events', true);
    expect(resolveTabs(config, ALL, 'tasks').rail).toEqual(['tasks', 'week', 'routines', 'checklists']);
    expect(resolveTabs(setTabHidden(config, ALL, 'events', false), ALL, 'tasks').rail).toContain('events');
  });

  it('un onglet masqué reste affiché tant qu’il est actif (critère 7)', () => {
    const config = setTabHidden(DEFAULT_TABS_CONFIG, ALL, 'events', true);
    expect(resolveTabs(config, ALL, 'events').rail).toEqual(['tasks', 'week', 'routines', 'events', 'checklists']);
    expect(resolveTabs(config, ALL, 'week').rail).not.toContain('events');
  });

  it('Tâches et Réglages ne se masquent ni ne se déplacent jamais (critères 5 et 10)', () => {
    let config = setTabHidden(DEFAULT_TABS_CONFIG, ALL, 'tasks', true);
    config = setTabHidden(config, ALL, 'settings', true);
    for (const id of ['week', 'routines', 'events', 'checklists']) config = setTabHidden(config, ALL, id, true);
    expect(resolveTabs(config, ALL, 'tasks')).toEqual({ rail: ['tasks'], last: 'settings' });
    expect(moveTab(DEFAULT_TABS_CONFIG, ALL, 'tasks', 3)).toBe(DEFAULT_TABS_CONFIG);
    expect(moveTab(DEFAULT_TABS_CONFIG, ALL, 'settings', 0)).toBe(DEFAULT_TABS_CONFIG);
    expect(resolveTabs({ order: ['settings', 'tasks', 'week'], hidden: ['tasks', 'settings'] }, ALL, 'tasks').rail[0]).toBe('tasks');
  });

  it('ignore un identifiant inconnu (version future) et ajoute un nouvel onglet à la fin (critère 9)', () => {
    const config = { order: ['future', 'checklists', 'week', 'week'], hidden: ['future', 'routines'] };
    expect(orderedCustomizableTabs(config, ALL)).toEqual(['checklists', 'week', 'routines', 'events']);
    expect(hiddenTabs(config, ALL)).toEqual(['routines']);
    expect(orderedCustomizableTabs({ order: ['week'], hidden: [] }, [...ALL, 'notes'])).toEqual(['week', 'routines', 'events', 'checklists', 'notes']);
  });

  it('un onglet masqué ne répond plus à son raccourci, sauf s’il est actif (critère 6)', () => {
    const config = setTabHidden(DEFAULT_TABS_CONFIG, ALL, 'week', true);
    expect(isTabAvailable(config, ALL, 'week', 'tasks')).toBe(false);
    expect(isTabAvailable(config, ALL, 'week', 'week')).toBe(true);
    expect(isTabAvailable(config, ALL, 'routines', 'tasks')).toBe(true);
    expect(isTabAvailable(config, ALL, 'settings', 'tasks')).toBe(true);
  });

  it('déplacement borné et compte des visibles (critère 1 : « 5 visibles »)', () => {
    expect(moveTab(DEFAULT_TABS_CONFIG, ALL, 'week', 99).order).toEqual(['routines', 'events', 'checklists', 'week']);
    expect(moveTab(DEFAULT_TABS_CONFIG, ALL, 'checklists', -4).order).toEqual(['checklists', 'week', 'routines', 'events']);
    expect(visibleTabCount(DEFAULT_TABS_CONFIG, ALL)).toBe(5);
    expect(visibleTabCount(setTabHidden(DEFAULT_TABS_CONFIG, ALL, 'events', true), ALL)).toBe(4);
  });
});
